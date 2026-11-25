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
// turns so that 對啊 stays with what it answers.
//
// The talk is 'worries' or 'light' (small talk, or the sutra). The turns in
// view include the session before, so the first message after a break is
// sorted with what was said before it.
export async function sortTalk(provider, { recentTurns, previousSession }, userText, signal) {
  const turns = [...(previousSession?.turns ?? []), ...recentTurns].slice(-6)
  const question =
    '你在替一個聊天機器人分派訊息。看最近的對話和最新一則訊息，判斷這段對話現在屬於哪一類，只回答一個字母。\n' +
    'A：輕鬆閒聊。打招呼、玩笑、分享日常小事或好心情、隨口的抱怨（好想翹班、熱死了、襪子又少一隻）、問機器人自己的事\n' +
    'B：問金剛經、佛法、經文的意思。前面在問經文、現在接著追問那句話的，也算這一類\n' +
    'C：心事。煩惱、低落、卡住、關係或工作上的困擾，或是在問這類事情該怎麼辦（有什麼方法、怎麼改善）\n' +
    '只要話裡帶著不想活、想消失、不想醒來、撐不下去、沒有自己比較好的意思，或像在道別、交代事情，不管語氣多輕鬆、是不是在問經文，一律回答 C。\n\n' +
    `最近的對話：\n${turns.map(oneLine).join('\n') || '（還沒有）'}\n\n最新一則：${userText}`
  const answer = await provider.ask(question, { signal: within(signal, ASK_WITHIN_MS) })
  // The letter may come with more (C。, **C**, 答：C, A（也可能是 C）). Any C in
  // the answer is worries; light takes an A or a B alone.
  const letters = answer.normalize('NFKC').toUpperCase().replace(/[^A-Z]/g, '')
  if (letters.includes('C')) return 'worries'
  if (letters === 'A' || letters === 'B') return 'light'
  throw new Error('the sorting answered neither A, B nor C')
}

// Unsorted, the talk is neither kind, and the chat model answers.
async function kindOfTalk(provider, context, userText, signal) {
  try {
    return await sortTalk(provider, context, userText, signal)
  } catch (err) {
    console.warn(`The talk was not sorted: ${err.message}`)
    return null
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
// when its time is up), the chat model does. The model for worries gets half
// of the time left, 20 seconds at most, and is asked only when that is 10
// seconds or more: at high effort Sonnet 5.5 took up to 8 seconds over 52
// replies (2026-11-26). So the chat model always keeps at least half of what
// it would have without a second model.
const MODEL_FOR_WORRIES_NEEDS_MS = 10_000
const MODEL_FOR_WORRIES_AT_MOST_MS = 20_000
const timeForTheModelForWorries = (left) => Math.min(left / 2, MODEL_FOR_WORRIES_AT_MOST_MS)

// Sorting comes first and may take ASK_WITHIN_MS. When the model for worries
// would then have no time to write, the talk is not sorted and the chat model
// answers: a message that arrived with 5 seconds left lost 3 of them to
// sorting and got the apology (2026-11-26 review).
const timeToThinkFirst = (deadline) => timeForTheModelForWorries(deadline - Date.now() - ASK_WITHIN_MS) >= MODEL_FOR_WORRIES_NEEDS_MS

async function answer(provider, context, userText, { worries, signal, deadline }) {
  const room = timeForTheModelForWorries(deadline - Date.now())
  if (worries && room >= MODEL_FOR_WORRIES_NEEDS_MS) {
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
// it, so the chat model is asked, and only when the closing sentence has 還是
// in it.
//
// A question after someone's safety is often a choice too (是想好好睡一場，
// 還是有不想再醒的念頭), and it is the one question that must go out: lines
// that could go either way are left to the model, which asks (crisis.mjs).
// Nothing here tells that question from the rest for certain. Lists of words
// are never complete (reviewers kept writing such questions that got past
// them), and the chat model took 8 of 10 for a choice even when told they
// are none (2026-11-26).
// So the closing choice is taken off only talk sorted as light, and talk
// about worries, like talk that was not sorted, goes out as written. The
// sorting is told that a line with not wanting to live in it is no small
// talk however lightly said. In light talk the lists below are still checked
// first. Leaving a choice in costs little; taking that question out does not.
const ASKS_AFTER_THEIR_SAFETY =
  /念頭|想不開|醒|死|活著|活下去|想活|傷害|自傷|消失|不見|不在了|不存在|出事|這一切|這個世界|那個地方|離開|回來|很遠|告別|道別|再見|最後|明天|交代|想太多|撐|危險|安全|平安|一個人|身邊有人|有人陪|有人在|有地方|今晚|現在人在|認真|說真的|真的這樣想|脫口而出|玩笑|氣話|結束|解脫|了結|了斷|放棄自己|放棄一切|傻事|極端|打算|方法|計畫|藥|刀|炭|讓自己|放棄|life|live|die|dead|done|bye/i
const NEAR_A_CRISIS =
  /想去?死|想要死|不想活|不要活|不活了|活膩|活不下去|活下去|活著|撐不下去|撐不住|撐不了|不想撐|自殺|輕生|自殘|傷害自己|結束|消失|不在了|沒有我|一睡不醒|不想醒|不要醒|醒不來|想走了|先走了|想不開|生無可戀|沒意義|沒有意義|解脫|放棄自己|放棄一切|放棄人生|負擔|累贅|保重|遺書|遺言|後事|木炭|燒炭|安眠藥|農藥|吞藥|[存囤].{0,6}藥|頂樓|擔心你|放心不下|1925|1995|1980|119|113|專線|認真/
const nearACrisis = (text) => NEAR_A_CRISIS.test(text) || talksOfEndingLife(text)

// What the person said lately, the session before included: a crisis three
// hours ago is there.
const saidLately = ({ recentTurns, previousSession }, userText) => [
  userText,
  ...[...(previousSession?.turns ?? []), ...recentTurns].filter(({ role }) => role === 'user').slice(-6).map(({ content }) => content),
]
// The summary stays for 30 days and is written in plain words, so only plain
// words count there: 結束 or 認真 in it would keep every reply whole for a month.
const SAID_PLAINLY = /想死|不想活|自殺|輕生|自殘|傷害自己|專線/
const crisisRemembered = ({ summary }) => Boolean(summary) && (SAID_PLAINLY.test(summary) || talksOfEndingLife(summary))

const LEAST_LEFT_TO_SEND = 4
const SENTENCE = /[^。！？!?\n]+[。！？!?～~]*\s*/g
const hasWords = ({ 0: sentence }) => /[一-鿿A-Za-z]/.test(sentence)
const hanCount = (text) => (text.match(/[一-鿿]/g) ?? []).length
const PAIRS = ['（）', '()', '「」', '『』']
const LEADS_IN = /問|確認|好奇|請教|猜|想知道|了解|在想|想說|說說看|(所以|那|還有|另外|然後|不過|但是|只是|就是)$/

// With its closing sentence gone, the rest has to be a reply by itself: more
// than a word, no lead-in left hanging (我想問你一件事。讓我猜猜看。所以), no
// bracket or quote left open.
function standsAlone(rest) {
  if (hanCount(rest) < LEAST_LEFT_TO_SEND || /[：:，,、—–…⋯→-]$|\.{2,}$/.test(rest)) return false
  const lastSentence = rest.split(/[。！？!?\n]+/).filter((part) => part.trim()).at(-1) ?? ''
  if (LEADS_IN.test(lastSentence.trim())) return false
  return PAIRS.every(([open, close]) => rest.split(open).length === rest.split(close).length)
}

// For a reply in light talk. Only one shape is cut, the one the chat model
// writes there (10 closing choices of 10 in recorded small talk and sutra
// talk): a choice whole in the closing sentence, after a finished thought.
// Every other shape stays as written; three reviews each found another one
// that went out broken (2026-11-26).
async function withoutClosingChoice(provider, reply, userText, context, signal) {
  if (!provider.answersQuestions) return reply
  const sentences = [...reply.matchAll(SENTENCE)]
  const last = sentences.findLastIndex(hasWords)
  const closing = sentences[last]?.[0].trim() ?? ''
  // 還是… that carries on from the question before it would take that question
  // along, and that one may be 這是在跟我告別嗎？
  if (!closing.includes('還是') || closing.startsWith('還是')) return reply
  // A finished thought before it: a paragraph of its own, or a sentence that ended.
  const before = reply.slice(0, sentences[last].index)
  if (!/\n\s*\n\s*$|[。！？!?]\s*$/.test(before)) return reply
  const rest = before.trim()
  if (!standsAlone(rest)) return reply

  if (ASKS_AFTER_THEIR_SAFETY.test(closing) || nearACrisis(reply) || saidLately(context, userText).some(nearACrisis) || crisisRemembered(context)) return reply

  // Asked this way the chat model took 5 of 92 closing statements for a
  // choice and missed none of 32 real ones; shown what the person said and
  // told to spare questions after their safety, it missed 6 of the 32 and
  // spared only 2 such questions of 10 (2026-11-26).
  const question =
    '下面是一則聊天回覆的最後一句。請判斷：它是不是在要對方從兩個或幾個選項裡挑一個來回答（例如「是他們變了，還是你變了」）。\n' +
    '如果「還是」的意思是「仍然」或「最好」，或者它只是在問對方要不要繼續聊、要不要先停下來，就不算。\n' +
    `只回答一個字：是，或 否。\n\n最後一句：「${closing}」`
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
    // What the caller says of the talk comes first. Unsorted, it is neither kind.
    let talk = worries === true ? 'worries' : worries === false ? 'light' : null
    if (talk === null && provider.answersWorries && timeToThinkFirst(deadline)) {
      talk = await kindOfTalk(provider, context, userText, signal)
    }
    const text = stripMarkdown(await answer(provider, context, userText, { worries: talk === 'worries', signal, deadline }))
    reply = talk === 'light' ? await withoutClosingChoice(provider, text, userText, context, signal) : text
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
