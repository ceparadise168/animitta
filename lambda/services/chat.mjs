import { getContext, saveTurn, compressOldTurns, archiveSession } from './memory.mjs'
import { getProvider } from '../providers/index.mjs'
import { buildMessages } from '../prompt.mjs'
import { replyMessage, replyWithQuickReply, showLoadingIndicator } from '../line.mjs'

function stripMarkdown(text) {
  return text.replace(/[*#_~`>]/g, '')
}

// Haiku 4.5 closes about four replies in ten on a question that makes the
// person pick one of two readings of their own life (是他們變了，還是你變了).
// Four prompt versions did not stop it. Shown the same replies with and
// without that question, unlabelled, the owner picked the ones without it in
// 7 conversations of 7 (2026-11-26). Only the closing sentence goes, and only
// when something is left to send.
//
// 還是 is also "still" (試過了，還是講不通) and "had better" (還是先休息吧),
// and cutting a statement costs more than leaving a question in, so the word
// alone is not enough: the sentence has to show that it asks. Over 423 replies
// the model wrote for made-up conversations this takes the closing choice off
// 94 and leaves 4 in (真的想去，還是就想想而已, with nothing that marks a
// question). Handing the direction back (還是先停在這也可以) is what the
// prompt asks for, and stays.
const HANDS_IT_BACK = /還是.{0,14}(也可以|也行|都可以|都行|也沒關係|都好|也好)[。.！!～~]?\s*$/
const SUGGESTS = /(吧|好了|算了|比較好|就好|再說)[。.！!～~]?\s*$/
const PAUSE = '[，、,；;：:—–]\\s*'
// 是他們變了，還是你變了; 是身體累還是心裡累. Not 那是你媽，還是會擔心的.
const IS_OR = new RegExp(
  `是[^。？?！!]{1,40}?(${PAUSE}|(?<![我你他她它們這那也都就卻但還人]))還是(?!會|要|得|很|覺得|放不下|忍不住|值得|可以|應該|比較|老樣子|一樣)`,
)
// 看得到外面嗎，還是被困在裡面: the first half already asks.
const ASKS_THEN_OR = new RegExp(`(嗎|呢|有沒有|是不是|要不要|會不會|什麼|怎麼|多久|哪|誰|為什麼)[^。？?！!]{0,30}${PAUSE}還是`)
// 真的想去，還是就想想而已？
const OR_WITH_MARK = new RegExp(`${PAUSE}還是[^。！!]*[？?]\\s*$`)
const ASKS = /[？?]\s*$|(嗎|呢)\s*$|有沒有|是不是|什麼|怎麼|多久|哪|誰|為什麼/

function offersAChoice(sentence, sentenceBefore) {
  if (!sentence.includes('還是') || HANDS_IT_BACK.test(sentence)) return false
  if (SUGGESTS.test(sentence) && !/[？?]/.test(sentence)) return false
  // 還是說一直都有: carries on the question before it.
  if (sentence.startsWith('還是')) return /[？?]\s*$/.test(sentence) || ASKS.test(sentenceBefore)
  return IS_OR.test(sentence) || ASKS_THEN_OR.test(sentence) || OR_WITH_MARK.test(sentence)
}

// Near a crisis the reply stays as the model wrote it: there, "do you mean it,
// or is it a way of saying you are worn out" is the right question.
const NEAR_A_CRISIS = /想死|不想活|活不下去|活下去|自殺|輕生|自殘|傷害自己|結束|消失|1925|1995|1980|119|113|專線|認真/

function withoutClosingChoice(reply, userText) {
  if (NEAR_A_CRISIS.test(reply) || NEAR_A_CRISIS.test(userText)) return reply
  const paragraphs = reply.trim().split(/\n\s*\n/)
  const sentences = paragraphs.at(-1).match(/[^。！？!?\n]+[。！？!?～~]*\n?/g) ?? [paragraphs.at(-1)]
  if (!offersAChoice(sentences.at(-1).trim(), (sentences.at(-2) ?? '').trim())) return reply
  const kept = sentences.slice(0, -1).join('').trim()
  const rest = kept ? [...paragraphs.slice(0, -1), kept] : paragraphs.slice(0, -1)
  return rest.length ? rest.join('\n\n') : reply
}

// LINE's reply token lasts one minute from the webhook. A model still writing
// 55 seconds after the user sent the message is given up on (it gets at least
// 5 seconds), so the fallback apology still reaches the user in time.
const answerWithin = (sentAt) => Math.max(5_000, sentAt + 55_000 - Date.now())

/**
 * Answer the user's words. onReplied runs once the reply has reached LINE, so
 * a caller can tell a failure before the answer from one after it. before is
 * a fixed message sent ahead of the model's answer in the same reply, such as
 * a passage of the sutra, and is remembered with it.
 */
export async function handleText(userId, replyToken, userText, sentAt, { onReplied, before } = {}) {
  const provider = getProvider()

  // The answer may take until the 55-second deadline; LINE's own default is 20.
  showLoadingIndicator(userId, 60).catch((err) => console.warn(err.message))

  let context, reply
  try {
    context = await getContext(userId)
    const budget = answerWithin(sentAt)
    const { text } = await provider.chatCompletion(buildMessages({ ...context, userInput: userText }), {
      signal: AbortSignal.timeout(budget),
      deadline: Date.now() + budget,
    })
    reply = withoutClosingChoice(stripMarkdown(text), userText)
    await replyMessage(replyToken, before ? [before, reply] : reply)
  } catch (err) {
    // Whoever apologises instead has to know what went unanswered.
    throw withUnanswered(err, userText)
  }
  onReplied?.()

  await remember(userId, context, userText, before ? `${before}\n\n${reply}` : reply, provider, sentAt)
}

// Writing onto a frozen error or a thrown string would itself throw and hide
// the real error, and the crisis apology with it, so those are wrapped instead.
function withUnanswered(err, userText) {
  const carrier =
    typeof err === 'object' && err !== null && Object.isExtensible(err)
      ? err
      : new Error(String(err?.message ?? err), { cause: err })
  // Not enumerable, so logging the error never prints what the person said.
  Object.defineProperty(carrier, 'unanswered', { value: userText, configurable: true })
  return carrier
}

// For a fixed bot line that the next message may answer, such as the
// casual-chat opener. userSide records what the user did to get it; quickReply
// adds buttons under the message (LINE's Quick Reply).
export async function replyAndRemember(userId, replyToken, userSide, reply, sentAt, { quickReply } = {}) {
  await (quickReply ? replyWithQuickReply(replyToken, reply, quickReply) : replyMessage(replyToken, reply))
  await remember(userId, await getContext(userId), userSide, reply, getProvider(), sentAt)
}

// Every exchange the bot takes part in is written here, so a new way of
// talking to the bot cannot skip the session bookkeeping. The exchange is saved
// before any summarizing, so a failed summary never loses what was just said.
async function remember(userId, { previousSession }, userText, reply, provider, sentAt) {
  const kept = await saveTurn(userId, userText, reply, sentAt)
  if (!kept) return
  if (previousSession) await archiveSession(userId, previousSession, provider)
  await compressOldTurns(userId, provider)
}
