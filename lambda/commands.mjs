import { replyMessage, replyWithQuickReply } from './line.mjs'
import { clearMemory, getContext, RETENTION_DAYS } from './services/memory.mjs'
import { handleText, replyAndRemember } from './services/chat.mjs'
import { VOICE_MINUTES_PER_MONTH } from './services/voice.mjs'
import { DAILY_LINES, askAboutLine, lineAt, lineIn, lineReply, passageOf, showsPassageOf, todaysLine } from './sutra.mjs'

const CASUAL_CHAT_STARTERS = [
  '嗨～今天過得還好嗎？\n想到什麼都可以直接聊。',
  '想到什麼就說什麼，沒頭沒尾也沒關係。',
  '不用急，慢慢來。\n你現在在想什麼？',
  '想閒聊、想碎念，都歡迎！\n不用找什麼正經理由。',
  '想聊什麼都可以。\n如果剛好沒話題，也可以打開選單按「每日一句」。',
]

const CLEAR_FAILED_REPLY = '記憶還沒清乾淨，等一下再按一次「清除記憶」好嗎'

// With a backup configured, people's words may go to Amazon instead, so 關於 says so.
const AI_SERVICE = {
  anthropic: process.env.BEDROCK_MODEL_ID
    ? 'Anthropic 或 Amazon 日本機房的 Claude'
    : 'Claude',
  openai: 'OpenAI 的 GPT',
}[process.env.LLM_PROVIDER || 'openai']

const ABOUT_MESSAGE =
  '無相界是一個帶著《金剛經》視角的自在聊天空間。\n' +
  '不求籤、不說教，也不必先懂佛學——想聊日常、理思緒，或隨手讀一句經文都很歡迎！\n\n' +
  '【記憶與隱私】\n' +
  `對話傳送與存放都加密，記憶只用來接話，${RETENTION_DAYS} 天未互動自動清空（或隨時按「清除記憶」）。\n` +
  `文字由 ${AI_SERVICE} 處理（不用於訓練）；語音經 Amazon 轉文字後即刪，每月上限 ${VOICE_MINUTES_PER_MONTH} 分鐘。\n\n` +
  '【原始碼】\n' +
  '公開的原始碼在這，想了解你的訊息如何被處理，或是想做一個專屬於你的 bot 都歡迎參考：\n' +
  'https://github.com/ceparadise168/animitta#readme\n\n' +
  '【緣起與維護】\n' +
  '這是我上一份工作時受公司理念啟發的個人專案，目前個人自費維護。\n' +
  '覺得有幫助的話，歡迎分享給朋友，或隨喜捐款支持慈善團體！\n\n' +
  '建議與聯繫：erictu.engineer@gmail.com'

const COMMANDS = {
  '@隨意聊聊': (userId, replyToken, sentAt) => handleCasualChat(userId, replyToken, sentAt),
  '@每日一句': (userId, replyToken, sentAt) => handleTodaysLine(userId, replyToken, sentAt),
  '@清除記憶': (userId, replyToken) => handleClearMemory(replyToken),
  '@關於': (userId, replyToken) => replyMessage(replyToken, ABOUT_MESSAGE),
}

// Only the exact menu texts are commands; "@_@ 今天好累" is a message.
export const isCommand = (text) => Object.hasOwn(COMMANDS, text)

export async function handleCommand(userId, replyToken, command, sentAt) {
  return COMMANDS[command](userId, replyToken, sentAt)
}

export async function handlePostback(userId, replyToken, data, sentAt) {
  if (data === 'action=casual_chat') {
    return handleCasualChat(userId, replyToken, sentAt)
  }
  if (data === 'action=daily_line') {
    return handleTodaysLine(userId, replyToken, sentAt)
  }
  const params = new URLSearchParams(data)
  if (params.get('action') === 'daily_line_next') {
    return handleNextLine(userId, replyToken, lineShown(params.get('line'), sentAt), sentAt)
  }
  if (params.get('action') === 'daily_line_more') {
    return handleMoreAboutLine(userId, replyToken, lineShown(params.get('line'), sentAt), sentAt)
  }
  if (data === 'confirm:clear') {
    try {
      await clearMemory(userId, sentAt)
    } catch (err) {
      await replyMessage(replyToken, CLEAR_FAILED_REPLY)
      throw err
    }
    return replyMessage(replyToken, '好的，記憶已清空 ✨ 我們從這裡重新開始')
  }
  if (data === 'confirm:cancel') {
    return replyMessage(replyToken, '好的，那我們繼續 😊')
  }
}

async function handleCasualChat(userId, replyToken, sentAt) {
  const opener =
    CASUAL_CHAT_STARTERS[Math.floor(Math.random() * CASUAL_CHAT_STARTERS.length)]
  return replyAndRemember(userId, replyToken, '（按了選單的「隨意聊聊」）', opener, sentAt)
}

// Under each 每日一句 message, two buttons: 多了解這一段 shows the whole chapter
// as it reads, then the model explains it like a question the person typed; 再給一句
// brings the next line in the sutra's order, so it is reading on, not a draw.
// The buttons go only under these fixed lines, never under chat replies (the
// suggestion buttons taken off on 2026-05-21 had people tapping instead of
// thinking).
const lineFollowUps = ({ index }) => [
  { label: '多了解這一段', data: `action=daily_line_more&line=${index}` },
  { label: '再給一句', data: `action=daily_line_next&line=${index}` },
]

// The line a button was under; an unreadable one means today's.
function lineShown(written, sentAt) {
  const index = /^\d+$/.test(written ?? '') ? Number(written) : NaN
  return index < DAILY_LINES.length ? lineAt(index) : todaysLine(sentAt)
}

const PRESSED_TODAYS_LINE = '（按了選單的「每日一句」）'
const PRESSED_NEXT_LINE = '（按了「再給一句」）'

// What the bot still remembers word for word: this session's turns, and the
// session before until it is folded into the summary.
const rememberedTurns = ({ recentTurns, previousSession }) => [...(previousSession?.turns ?? []), ...recentTurns]

// The daily lines shown to this person in what the bot remembers, oldest first.
function linesSeen(turns) {
  return turns.flatMap((turn, i) => {
    const pressed = turn.role === 'user' && [PRESSED_TODAYS_LINE, PRESSED_NEXT_LINE].includes(turn.content)
    const line = pressed && turns[i + 1]?.role === 'assistant' ? lineIn(turns[i + 1].content) : null
    return line ? [line] : []
  })
}

// Remembered like the casual-chat opener, so whatever the person says next is
// answered as a reply to the line, with its chapter at hand if they ask. Once
// today's line has been shown, pressing again reads on from the last line shown
// instead of bringing the same one back (2026-11-25: three presses in six
// minutes brought one line three times).
async function handleTodaysLine(userId, replyToken, sentAt) {
  const today = todaysLine(sentAt)
  const seen = linesSeen(rememberedTurns(await getContext(userId)))
  const readOn = seen.some(({ index }) => index === today.index)
  const shown = readOn ? lineAt(seen.at(-1).index + 1) : today
  return replyAndRemember(userId, replyToken, PRESSED_TODAYS_LINE, lineReply(shown, { first: !readOn }), sentAt, {
    quickReply: lineFollowUps(shown),
  })
}

async function handleNextLine(userId, replyToken, shown, sentAt) {
  const next = lineAt(shown.index + 1)
  return replyAndRemember(userId, replyToken, PRESSED_NEXT_LINE, lineReply(next), sentAt, {
    quickReply: lineFollowUps(next),
  })
}

// A chapter already shown in what the bot remembers is not sent again: the
// person has it just above, and the model has it from the lookup either way
// (2026-11-25: one chapter three times in six minutes).
async function handleMoreAboutLine(userId, replyToken, shown, sentAt) {
  const shownBefore = rememberedTurns(await getContext(userId)).some(
    ({ role, content }) => role === 'assistant' && showsPassageOf(content, shown),
  )
  return handleText(userId, replyToken, askAboutLine(shown), sentAt, shownBefore ? {} : { before: passageOf(shown) })
}

async function handleClearMemory(replyToken) {
  return replyWithQuickReply(
    replyToken,
    '確定要清除記憶嗎？這次之後我就會忘掉我們之前所有的對話喔',
    [
      { label: '確定', data: 'confirm:clear', inputOption: 'openKeyboard' },
      { label: '取消', data: 'confirm:cancel', inputOption: 'openKeyboard' },
    ]
  )
}
