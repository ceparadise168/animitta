import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { downloadContent, showLoadingIndicator } from '../line.mjs'
import { transcribe } from './transcribe.mjs'
import { whyRecordingsMayBeKept } from './ai-opt-out.mjs'
import { handleText, replyAndRemember } from './chat.mjs'

const client = new DynamoDBClient()
const TABLE = process.env.MEMORY_TABLE_NAME

export const VOICE_MINUTES_PER_MONTH = parseInt(process.env.VOICE_MINUTES_PER_MONTH || '30', 10)
const LIMIT_SECONDS = VOICE_MINUTES_PER_MONTH * 60

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
const OVER_LIMIT_REPLY =
  `這段語音超過這個月剩下的語音額度了（每個月 ${VOICE_MINUTES_PER_MONTH} 分鐘），我沒辦法聽。` +
  '想用說的，可以點鍵盤上的麥克風，說完會變成文字傳給我'
const NOTHING_HEARD_REPLY = '這段語音我沒聽到說話的聲音，可以再說一次，或打字給我嗎'
// Not "send it again": the pause lasts until the account is fixed.
const PAUSED_REPLY = '語音這邊暫時沒辦法聽，可以先打字，或點鍵盤上的麥克風說給我聽嗎'

// Months follow Taipei time, where the users are.
const monthOf = (sentAt) => new Date(sentAt + 8 * 3600_000).toISOString().slice(0, 7)

function counterKey(userId, sentAt) {
  return { pk: { S: `USER#${userId}` }, sk: { S: `VOICE#${monthOf(sentAt)}` } }
}

// Counts the seconds against this month only if they still fit, in one
// conditional write, so two messages at once cannot both slip past the limit.
async function reserveSeconds(userId, sentAt, seconds) {
  if (seconds > LIMIT_SECONDS) return false
  try {
    await client.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: counterKey(userId, sentAt),
        UpdateExpression: 'SET #ttl = :ttl ADD #used :seconds',
        ConditionExpression: 'attribute_not_exists(#used) OR #used < :room',
        ExpressionAttributeNames: { '#ttl': 'ttl', '#used': 'usedSeconds' },
        ExpressionAttributeValues: {
          ':ttl': { N: String(Math.floor(Date.now() / 1000) + COUNTER_DAYS * 86400) },
          ':seconds': { N: String(seconds) },
          ':room': { N: String(LIMIT_SECONDS - seconds + 1) },
        },
      })
    )
    return true
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false
    throw err
  }
}

// A voice message the bot failed to hear or answer does not use up the user's minutes.
async function giveBackSeconds(userId, sentAt, seconds) {
  await client
    .send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: counterKey(userId, sentAt),
        UpdateExpression: 'ADD #used :refund',
        ConditionExpression: 'attribute_exists(#used)',
        ExpressionAttributeNames: { '#used': 'usedSeconds' },
        ExpressionAttributeValues: { ':refund': { N: String(-seconds) } },
      })
    )
    .catch((err) => console.warn(`Voice seconds not given back: ${err.name}`))
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

  if (!(await reserveSeconds(userId, sentAt, seconds))) {
    return replyAndRemember(userId, replyToken, REMEMBERED_AS, OVER_LIMIT_REPLY, sentAt)
  }

  showLoadingIndicator(userId, 60).catch((err) => console.warn(err.message))

  try {
    const deadline = sentAt + TRANSCRIBE_BUDGET_MS
    const words = await transcribe(await downloadContent(message.id, deadline), { deadline })
    if (!words) return await replyAndRemember(userId, replyToken, REMEMBERED_AS, NOTHING_HEARD_REPLY, sentAt)
    return await handleText(userId, replyToken, words, sentAt)
  } catch (err) {
    await giveBackSeconds(userId, sentAt, seconds)
    throw err
  }
}
