import { replyMessage, replyWithQuickReply } from './line.mjs'
import { clearMemory, RETENTION_DAYS } from './services/memory.mjs'
import { handleText, replyAndRemember } from './services/chat.mjs'
import { VOICE_MINUTES_PER_MONTH } from './services/voice.mjs'
import { DAILY_LINES, askAboutLine, lineAt, lineReply, passageOf, todaysLine } from './sutra.mjs'

const CASUAL_CHAT_STARTERS = [
  '嗨，這邊很隨意，不用拘束\n\n想講最近煩你的事、一個轉不掉的念頭，或想問我金剛經裡的哪句話，都可以。不用先想好怎麼說，現在心裡最放不下的那件事，直接講出來就好',
  '今天不一定要從經文開始\n\n想抒發、想問點什麼、想聊金剛經，都行。腦袋裡本來怎麼想，就怎麼講，講得亂也沒關係',
  '我在\n\n可以聊日常，也可以聊那些沒有標準答案的事。想聊哪一種都可以',
  '如果你想聽金剛經裡的一句話，我會想到：「過去心不可得、現在心不可得、未來心不可得。」\n\n不用急著懂它。你也可以就說說看，今天有哪個念頭一直回來',
  '隨意聊聊就從一句話開始\n\n最近一直卡在你心裡的那件事，從哪裡講起都可以',
]

const CLEAR_FAILED_REPLY = '記憶還沒清乾淨，等一下再按一次「清除記憶」好嗎'

// With a backup configured, people's words may go to Amazon instead, so 關於 says so.
const AI_SERVICE = {
  anthropic: process.env.BEDROCK_MODEL_ID
    ? '平常是 Anthropic 的 Claude；Anthropic 那邊出狀況時，改由 Amazon 在日本的機房執行同一個 Claude 模型'
    : 'Anthropic 的 Claude',
  openai: 'OpenAI 的 GPT',
}[process.env.LLM_PROVIDER || 'openai']

const ABOUT_MESSAGE =
  '無相界是一個帶著金剛經視角的自在聊天空間。你可以抒發煩惱、問生活裡卡住的事，也可以單純想理解《金剛經》在說什麼。\n\n' +
  '它不是籤詩機，也不是佛學講堂。金剛經在這裡比較像底色：需要時拿來照一下，不需要時就好好聊天。\n\n' +
  '它會記得你最近跟它聊過的，下次才接得上；比較早的會整理成一段重點。這些記憶只用來讓它接得上話，不會拿去做別的事。\n\n' +
  `想馬上清空，按選單的「清除記憶」就好；${RETENTION_DAYS} 天沒來聊天，也會全部自動刪掉。\n\n` +
  `訊息在傳送和存放時都有加密，不過要產生回覆，你傳的文字還是會交給 AI 服務（${AI_SERVICE}）處理。\n\n` +
  `傳語音的話，會先交給 Amazon 的語音辨識轉成文字，轉好就把錄音刪掉；每個月最多可以傳 ${VOICE_MINUTES_PER_MONTH} 分鐘。\n\n` +
  '目前由我個人自費維護。如果你覺得有幫助，歡迎分享給朋友；若想將這份善意延續下去，也歡迎隨喜捐款給你支持的慈善團體。\n\n' +
  '有任何建議，都歡迎寫信給我：erictu.engineer@gmail.com'

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
    const shown = lineShown(params.get('line'), sentAt)
    return handleText(userId, replyToken, askAboutLine(shown), sentAt, { before: passageOf(shown) })
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

// Remembered like the casual-chat opener, so whatever the person says next is
// answered as a reply to the line, with its chapter at hand if they ask.
async function handleTodaysLine(userId, replyToken, sentAt) {
  const today = todaysLine(sentAt)
  return replyAndRemember(userId, replyToken, '（按了選單的「每日一句」）', lineReply(today, { first: true }), sentAt, {
    quickReply: lineFollowUps(today),
  })
}

async function handleNextLine(userId, replyToken, shown, sentAt) {
  const next = lineAt(shown.index + 1)
  return replyAndRemember(userId, replyToken, '（按了「再給一句」）', lineReply(next), sentAt, {
    quickReply: lineFollowUps(next),
  })
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
