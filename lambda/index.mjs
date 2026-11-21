import { verifySignature, replyMessage, linkRichMenu } from './line.mjs'
import { handleText, replyAndRemember } from './services/chat.mjs'
import { handleCommand, handlePostback, isCommand } from './commands.mjs'

const WELCOME_MESSAGE =
  '嗨～我是無相界 🌿\n\n' +
  '這裡是帶著金剛經視角的聊天空間，但不用一開始就聊經文。\n\n' +
  '你可以抒發最近卡住的事、聊聊生活或工作上的選擇，也可以純粹想理解佛法在說什麼。想隨便講一句也可以，不用先想好怎麼說。\n\n' +
  '我會記得我們聊過的，下次才接得上。想讓我全部忘掉的話，按底下選單的「清除記憶」就好 😊'

const FALLBACK_REPLY = '我這邊暫時卡住了，沒辦法好好回你。過一下再傳一次給我好嗎'
const TEXT_ONLY_REPLY = '目前我只能讀文字，可以打字跟我說嗎'

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

export async function handler(event) {
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
      } else if (UNREADABLE_MESSAGES[msg.type]) {
        await replyAndRemember(userId, replyToken, UNREADABLE_MESSAGES[msg.type], TEXT_ONLY_REPLY, sentAt)
      }
    }
  } catch (err) {
    console.error('Handler error:', err)
    // Fails harmlessly when the reply token was already used before the error.
    await replyMessage(replyToken, FALLBACK_REPLY).catch(() => {})
  }
}
