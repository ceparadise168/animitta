import { verifySignature, replyMessage, linkRichMenu } from './line.mjs'
import { handleText, replyAndRemember } from './services/chat.mjs'
import { handleVoice } from './services/voice.mjs'
import { handleCommand, handlePostback, isCommand } from './commands.mjs'
import { CRISIS_FALLBACK_REPLY, talksOfEndingLife } from './crisis.mjs'
import { selfTest } from './self-test.mjs'

const WELCOME_MESSAGE =
  '嗨～ 這裡是無相界！\n\n' +
  '不求籤、不說教，也不必先懂佛學。\n' +
  '單純聊聊日常大小事、整理一下思緒，或是好奇看看《金剛經》在說什麼都歡迎！\n\n' +
  '文字或語音都行得通，希望《金剛經》的智慧能帶給你一點不一樣的想法～'

const FALLBACK_REPLY = '我這邊暫時卡住了，沒辦法好好回你。過一下再傳一次給我好嗎'
const TEXT_ONLY_REPLY = '這個我還看不懂，可以打字或傳語音跟我說嗎'
const LINKED_AUDIO_REPLY = '這段語音我打不開，可以直接在 LINE 裡錄音傳給我，或打字跟我說嗎'

// What the bot remembers the user sending when it cannot read the message.
const UNREADABLE_MESSAGES = {
  audio: '（傳了一段語音）',
  image: '（傳了一張圖片）',
  video: '（傳了一段影片）',
  file: '（傳了一個檔案）',
  location: '（傳了一個位置）',
}

// A sticker is how the user feels right now, so the model gets it as words.
function stickerAsText({ keywords = [], text }) {
  const parts = [keywords.join('、'), text && `上面寫著「${text.replace(/\s+/g, ' ')}」`].filter(Boolean)
  return parts.length ? `（傳了一張貼圖：${parts.join('，')}）` : '（傳了一張貼圖）'
}

// A direct invoke by someone with AWS access, never a webhook: requests through
// the function URL always carry requestContext.
const isSelfTest = (event) => event?.selfTest === true && !event.requestContext

export async function handler(event) {
  if (isSelfTest(event)) return selfTest()

  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body
  const signature = event.headers?.['x-line-signature'] || ''

  if (!verifySignature(body, signature, process.env.LINE_CHANNEL_SECRET)) {
    return { statusCode: 401, body: 'Invalid signature' }
  }

  // One webhook may carry several events, and not necessarily from one user.
  for (const lineEvent of JSON.parse(body).events || []) {
    await handleEvent(lineEvent)
  }

  return { statusCode: 200, body: 'OK' }
}

async function handleEvent(lineEvent) {
  // 無相界 talks one to one. Group and room events would all share one memory,
  // and channel events (activation, for one) carry no source at all.
  if (lineEvent.source?.type !== 'user' || !lineEvent.source.userId) return
  const { replyToken, timestamp: sentAt } = lineEvent
  const userId = lineEvent.source.userId

  try {
    if (lineEvent.type === 'follow') {
      // User added bot or unblocked — send welcome + re-link Rich Menu
      await replyMessage(replyToken, WELCOME_MESSAGE)
      if (process.env.RICH_MENU_ID) {
        linkRichMenu(userId, process.env.RICH_MENU_ID).catch(() => {})
      }
    } else if (lineEvent.type === 'postback') {
      await handlePostback(userId, replyToken, lineEvent.postback.data, sentAt)
    } else if (lineEvent.type === 'message') {
      const msg = lineEvent.message

      if (msg.type === 'text' && isCommand(msg.text)) {
        await handleCommand(userId, replyToken, msg.text, sentAt)
      } else if (msg.type === 'text') {
        await handleText(userId, replyToken, msg.text, sentAt)
      } else if (msg.type === 'sticker') {
        await handleText(userId, replyToken, stickerAsText(msg), sentAt)
      } else if (msg.type === 'audio' && msg.contentProvider?.type === 'external') {
        // Audio hosted elsewhere comes as a link LINE cannot hand over, so only
        // recordings sent in LINE are heard.
        await replyAndRemember(userId, replyToken, UNREADABLE_MESSAGES.audio, LINKED_AUDIO_REPLY, sentAt)
      } else if (msg.type === 'audio') {
        await handleVoice(userId, replyToken, msg, sentAt)
      } else if (UNREADABLE_MESSAGES[msg.type]) {
        await replyAndRemember(userId, replyToken, UNREADABLE_MESSAGES[msg.type], TEXT_ONLY_REPLY, sentAt)
      }
    }
  } catch (err) {
    console.error('Handler error:', err)
    // Fails harmlessly when the reply token was already used before the error.
    const apology = talksOfEndingLife(err?.unanswered) ? CRISIS_FALLBACK_REPLY : FALLBACK_REPLY
    await replyMessage(replyToken, apology).catch(() => {})
  }
}
