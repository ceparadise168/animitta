import { createHash } from 'node:crypto'
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { downloadContent, showLoadingIndicator } from '../line.mjs'
import { transcribe } from './transcribe.mjs'
import { whyRecordingsMayBeKept } from './ai-opt-out.mjs'
import { handleText, replyAndRemember } from './chat.mjs'

const client = new DynamoDBClient()
const TABLE = process.env.MEMORY_TABLE_NAME

export const VOICE_MINUTES_PER_MONTH = parseInt(process.env.VOICE_MINUTES_PER_MONTH || '30', 10)
// Everyone's voice minutes together, so a crowd of users cannot run up the
// Transcribe bill. At about US$0.006 a minute, 1,500 minutes is about US$9.
const MINUTES_FOR_EVERYONE = parseInt(process.env.VOICE_MINUTES_ALL_USERS_PER_MONTH || '1500', 10)
const USER_LIMIT_SECONDS = VOICE_MINUTES_PER_MONTH * 60
const EVERYONE_LIMIT_SECONDS = MINUTES_FOR_EVERYONE * 60
// Measured in Tokyo, 3.5 minutes of audio transcribed in about 20 seconds, which
// still leaves the model time to answer within LINE's one-minute reply token.
// Longer messages are turned away before anything is paid for.
const MAX_SECONDS_PER_MESSAGE = 180

// LINE's reply token lasts one minute from the webhook, and the clock starts
// when LINE sends it, not when this code runs: a cold start or an earlier
// event in the same webhook has already used some of it. Transcription must
// be done 40 seconds after the user sent the message, which leaves the model
// time to answer before the token goes.
const TRANSCRIBE_BUDGET_MS = 40_000
// A month's counter outlives the month, and goes before the 90 days the 關於
// message promises everything about a quiet user is gone.
const COUNTER_DAYS = 40

const REMEMBERED_AS = '（傳了一段語音）'
const LIMIT_REPLIES = {
  user:
    `這段語音超過你這個月剩下的語音額度了（每個月 ${VOICE_MINUTES_PER_MONTH} 分鐘，下個月 1 號重新計算），我沒辦法聽。` +
    '想用說的，可以點鍵盤上的麥克風，說完會變成文字傳給我',
  everyone:
    '這個月大家的語音額度已經用完了，下個月 1 號會恢復。' +
    '想用說的，可以點鍵盤上的麥克風，說完會變成文字傳給我',
}
const TOO_LONG_REPLY =
  `這段語音有點長，我一次最多能聽 ${MAX_SECONDS_PER_MESSAGE / 60} 分鐘。` +
  '可以分成短一點的幾段傳給我，或點鍵盤上的麥克風說給我聽嗎'
const NOTHING_HEARD_REPLY = '這段語音我沒聽到說話的聲音，可以再說一次，或打字給我嗎'
// Not "send it again": the pause lasts until the account is fixed.
const PAUSED_REPLY = '語音這邊暫時沒辦法聽，可以先打字，或點鍵盤上的麥克風說給我聽嗎'
// The stack's voice-limit alarm counts this line.
const EVERYONE_LIMIT_LOG = 'Voice limit for all users reached'

// Months follow Taipei time, where the users are.
const monthOf = (sentAt) => new Date(sentAt + 8 * 3600_000).toISOString().slice(0, 7)

// Two counters a month: one for each user, one for everyone together.
const userCounter = (userId, month) => ({ pk: { S: `USER#${userId}` }, sk: { S: `VOICE#${month}` } })
const everyoneCounter = (month) => ({ pk: { S: 'ALL_USERS' }, sk: { S: `VOICE#${month}` } })

// Adds the seconds to one counter only if they still fit under its limit, in
// one conditional write, so two messages at once cannot both slip past it.
async function addIfRoom(Key, seconds, limitSeconds) {
  if (seconds > limitSeconds) return false
  try {
    await client.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key,
        UpdateExpression: 'SET #ttl = :ttl ADD #used :seconds',
        ConditionExpression: 'attribute_not_exists(#used) OR #used < :room',
        ExpressionAttributeNames: { '#ttl': 'ttl', '#used': 'usedSeconds' },
        ExpressionAttributeValues: {
          ':ttl': { N: String(Math.floor(Date.now() / 1000) + COUNTER_DAYS * 86400) },
          ':seconds': { N: String(seconds) },
          ':room': { N: String(limitSeconds - seconds + 1) },
        },
      })
    )
    return true
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false
    throw err
  }
}

// Logs name a user by a hash, never the LINE id itself.
const hashed = (userId) => createHash('sha256').update(userId).digest('hex').slice(0, 12)

// A give-back the SDK could not get through, after its own retries, raises the
// failure alarm with what to add back by hand, so no minutes vanish unseen.
async function takeBack(Key, seconds, whose) {
  await client
    .send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key,
        UpdateExpression: 'ADD #used :refund',
        ConditionExpression: 'attribute_exists(#used)',
        ExpressionAttributeNames: { '#used': 'usedSeconds' },
        ExpressionAttributeValues: { ':refund': { N: String(-seconds) } },
      })
    )
    .catch((err) => console.error(`Handler error: voice seconds not given back: ${seconds} s for ${whose} (${err.name})`))
}

/**
 * Count a voice message against the user's minutes and everyone's minutes for
 * the month. Resolves to null when both had room, or to the limit that
 * stopped it ('user' or 'everyone'), in which case nothing stays counted.
 */
async function reserveSeconds(userId, sentAt, seconds) {
  const month = monthOf(sentAt)
  const mine = userCounter(userId, month)
  const whose = `user ${hashed(userId)} in ${month}`
  if (!(await addIfRoom(mine, seconds, USER_LIMIT_SECONDS))) return 'user'
  let fits
  try {
    fits = await addIfRoom(everyoneCounter(month), seconds, EVERYONE_LIMIT_SECONDS)
  } catch (err) {
    await takeBack(mine, seconds, whose)
    throw err
  }
  if (fits) return null
  await takeBack(mine, seconds, whose)
  return 'everyone'
}

// After a failure, the user gets back minutes they got no answer for.
// Everyone's count keeps any minutes Amazon may already bill, once a job was
// asked for, so failures cannot run the bill past the monthly total.
async function giveBackSeconds(userId, sentAt, seconds, { billed, answered }) {
  const month = monthOf(sentAt)
  await Promise.all([
    !answered && takeBack(userCounter(userId, month), seconds, `user ${hashed(userId)} in ${month}`),
    !billed && takeBack(everyoneCounter(month), seconds, `all users in ${month}`),
  ])
}

/**
 * Hear a voice message and answer it as if the user had typed the words.
 * LINE gives the length in milliseconds; a message without one counts as a
 * full minute.
 */
export async function handleVoice(userId, replyToken, message, sentAt) {
  // Checked first, so a paused voice uses none of the user's minutes. The log
  // line raises the same alarm as a failed reply.
  const risk = await whyRecordingsMayBeKept()
  if (risk) {
    console.error(`Handler error: voice paused, the recording was not sent to Amazon, because ${risk}`)
    return replyAndRemember(userId, replyToken, REMEMBERED_AS, PAUSED_REPLY, sentAt)
  }

  const seconds = message.duration ? Math.ceil(message.duration / 1000) : 60
  if (seconds > MAX_SECONDS_PER_MESSAGE) return replyAndRemember(userId, replyToken, REMEMBERED_AS, TOO_LONG_REPLY, sentAt)

  const stoppedBy = await reserveSeconds(userId, sentAt, seconds)
  if (stoppedBy === 'everyone') console.warn(`${EVERYONE_LIMIT_LOG}: ${MINUTES_FOR_EVERYONE} minutes in ${monthOf(sentAt)}`)
  if (stoppedBy) return replyAndRemember(userId, replyToken, REMEMBERED_AS, LIMIT_REPLIES[stoppedBy], sentAt)

  showLoadingIndicator(userId, 60).catch((err) => console.warn(err.message))

  const progress = { billed: false, answered: false }
  try {
    const deadline = sentAt + TRANSCRIBE_BUDGET_MS
    const audio = await downloadContent(message.id, deadline)
    const words = await transcribe(audio, { deadline, onJobStart: () => (progress.billed = true) })
    if (!words) return await replyAndRemember(userId, replyToken, REMEMBERED_AS, NOTHING_HEARD_REPLY, sentAt)
    return await handleText(userId, replyToken, words, sentAt, { onReplied: () => (progress.answered = true) })
  } catch (err) {
    await giveBackSeconds(userId, sentAt, seconds, progress)
    throw err
  }
}
