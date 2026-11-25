import { getContext, saveTurn, compressOldTurns, archiveSession } from './memory.mjs'
import { getProvider } from '../providers/index.mjs'
import { buildMessages } from '../prompt.mjs'
import { replyMessage, replyWithQuickReply, showLoadingIndicator } from '../line.mjs'
import { talksOfEndingLife } from '../crisis.mjs'

function stripMarkdown(text) {
  return text.replace(/[*#_~`>]/g, '')
}

// LINE's reply token lasts one minute from the webhook. A model still writing
// 55 seconds after the user sent the message is given up on (it gets at least
// 5 seconds), so the fallback apology still reaches the user in time.
const answerWithin = (sentAt) => Math.max(5_000, sentAt + 55_000 - Date.now())

// A question to the model that a reply waits on gets this long. Without an
// answer the reply goes out as it would have without the question.
const ASK_WITHIN_MS = 3_000
const within = (signal, ms) => AbortSignal.any([signal, AbortSignal.timeout(ms)])
const oneLine = ({ role, content }) => `${role === 'user' ? '使用者' : '無相界'}：${content.replace(/\s+/g, ' ').slice(0, 200)}`

// Worries go to a model of their own when there is one (WORRIES_MODEL_ANTHROPIC),
// small talk and questions about the sutra stay with the chat model. Shown
// both models' replies unlabelled, the owner picked the one that thinks first
// in 4 of 5 conversations about worries, and the chat model for small talk and
// for the sutra (2026-11-26); thinking first takes about 4 seconds longer. The
// chat model sorts each message in about half a second, with the last few
// turns so that 對啊 stays with what it answers. Unsorted, the chat model answers.
async function isAboutWorries(provider, recentTurns, userText, signal) {
  const question =
    '你在替一個聊天機器人分派訊息。看最近的對話和最新一則訊息，判斷這段對話現在屬於哪一類，只回答一個字母。\n' +
    'A：輕鬆閒聊、打招呼、玩笑、隨口的抱怨（好想翹班、熱死了）、問機器人自己的事\n' +
    'B：問金剛經、佛法、經文的意思。前面在問經文、現在接著追問那句話的，也算這一類\n' +
    'C：心事。煩惱、低落、卡住、關係或工作上的困擾，或是在問這類事情該怎麼辦\n\n' +
    `最近的對話：\n${recentTurns.slice(-6).map(oneLine).join('\n') || '（還沒有）'}\n\n最新一則：${userText}`
  try {
    return (await provider.ask(question, { signal: within(signal, ASK_WITHIN_MS) })).trim().startsWith('C')
  } catch (err) {
    console.warn(`The talk was not sorted: ${err.message}`)
    return false
  }
}

// Larger models have written their notes to themselves into the reply
// (<reasoning>…, <invoke name="x">: 4 or 5 of 52 replies from Sonnet 5.5 at low
// and medium effort, 2026-11-25). Such a reply is asked for once more.
const NOTES_TO_ITSELF = /<\/?(reasoning|thinking|reply|invoke|function_calls|scratchpad)\b/i

async function write(provider, context, userText, { worries, signal, deadline }) {
  const messages = buildMessages({ ...context, userInput: userText, worries })
  for (let attempt = 1; ; attempt++) {
    const { text } = await provider.chatCompletion(messages, { signal, deadline, worries })
    if (!NOTES_TO_ITSELF.test(text)) return text
    if (attempt === 2) throw new Error("the reply carried the model's notes to itself")
    console.warn("A reply carried the model's notes to itself; asking once more")
  }
}

// When the model for worries cannot answer (down, refusing, or still writing
// with this little time left), the chat model does, so a second model never
// costs anyone their reply.
const LEFT_FOR_THE_CHAT_MODEL_MS = 8_000

async function answer(provider, context, userText, { worries, signal, deadline }) {
  const room = deadline - Date.now() - LEFT_FOR_THE_CHAT_MODEL_MS
  if (worries && room > 0) {
    try {
      return await write(provider, context, userText, { worries, signal: within(signal, room), deadline: Date.now() + room })
    } catch (err) {
      if (signal.aborted) throw err
      console.warn(`The model for worries did not answer: ${err.message}; the chat model answers`)
    }
  }
  return write(provider, context, userText, { worries: false, signal, deadline })
}

// Haiku 4.5 closes about four replies in ten on a question that makes the
// person pick one of two readings of their own life (是他們變了，還是你變了).
// Four prompt versions did not stop it. Shown the same replies with and
// without that question, unlabelled, the owner picked the ones without it in
// 7 conversations of 7 (2026-11-26).
//
// 還是 is also "still" (試過了，還是講不通) and "had better" (還是先休息吧).
// Telling them apart by rule cut 54 of 72 closing statements written to try
// it, so the chat model is asked: of 92 such statements it took 6% for a
// choice, and it missed none of 32 real ones. It is asked only when the
// closing sentence has 還是 in it, about one reply in four.
const NEAR_A_CRISIS = /想死|不想活|活不下去|活下去|活著|撐不下去|撐不住|自殺|輕生|自殘|傷害自己|結束|消失|1925|1995|1980|119|113|專線|認真/
const OPEN_QUESTION = /什麼|怎麼|怎樣|多久|哪|誰|為什麼|如何/
const LEAST_LEFT_TO_SEND = 4
const hanCount = (text) => (text.match(/[一-鿿]/g) ?? []).length

async function withoutClosingChoice(provider, reply, userText, recentTurns, signal) {
  const paragraphs = reply.trim().split(/\n\s*\n/)
  const sentences = paragraphs.at(-1).match(/[^。！？!?\n]+[。！？!?～~]*\n?/g) ?? [paragraphs.at(-1)]
  if (!sentences.at(-1).includes('還是')) return reply

  // Near a crisis the reply stays as written: there, "do you mean it, or is it
  // a way of saying you are worn out" is the right question.
  const saidLately = [userText, ...recentTurns.filter(({ role }) => role === 'user').slice(-3).map(({ content }) => content)]
  if (NEAR_A_CRISIS.test(reply) || saidLately.some((said) => NEAR_A_CRISIS.test(said) || talksOfEndingLife(said))) return reply

  // 是今天特別悶？還是最近發生了什麼事？ is one choice in two sentences. After
  // an open question (多久了？還是最近才開始？) only the second half is.
  const carriesOn = sentences.length > 1 && sentences.at(-1).trim().startsWith('還是') && !OPEN_QUESTION.test(sentences.at(-2))
  const closing = sentences.slice(carriesOn ? -2 : -1)
  const kept = sentences.slice(0, sentences.length - closing.length).join('').trim()
  const rest = (kept ? [...paragraphs.slice(0, -1), kept] : paragraphs.slice(0, -1)).join('\n\n')
  if (hanCount(rest) < LEAST_LEFT_TO_SEND) return reply

  const question =
    '下面是一則聊天回覆的最後一句。請判斷：它是不是在要對方從兩個或幾個選項裡挑一個來回答（例如「是他們變了，還是你變了」）。\n' +
    '如果「還是」的意思是「仍然」或「最好」，或者它只是在問對方要不要繼續聊、要不要先停下來，就不算。\n' +
    `只回答一個字：是，或 否。\n\n最後一句：「${closing.join('').trim()}」`
  try {
    return (await provider.ask(question, { signal: within(signal, ASK_WITHIN_MS) })).trim().startsWith('是') ? rest : reply
  } catch (err) {
    console.warn(`The closing sentence was not judged: ${err.message}`)
    return reply
  }
}

/**
 * Answer the user's words. onReplied runs once the reply has reached LINE, so
 * a caller can tell a failure before the answer from one after it. before is
 * a fixed message sent ahead of the model's answer in the same reply, such as
 * a passage of the sutra, and is remembered with it. worries says whether the
 * words are about worries when the caller knows; otherwise they are sorted.
 */
export async function handleText(userId, replyToken, userText, sentAt, { onReplied, before, worries } = {}) {
  const provider = getProvider()

  // The answer may take until the 55-second deadline; LINE's own default is 20.
  showLoadingIndicator(userId, 60).catch((err) => console.warn(err.message))

  let context, reply
  try {
    context = await getContext(userId)
    const budget = answerWithin(sentAt)
    const signal = AbortSignal.timeout(budget)
    const deadline = Date.now() + budget
    const aboutWorries = worries ?? (provider.answersWorries && (await isAboutWorries(provider, context.recentTurns, userText, signal)))
    const text = await answer(provider, context, userText, { worries: aboutWorries, signal, deadline })
    reply = await withoutClosingChoice(provider, stripMarkdown(text), userText, context.recentTurns, signal)
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
