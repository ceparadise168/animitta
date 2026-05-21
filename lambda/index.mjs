import { verifySignature, replyMessage, linkRichMenu } from './line.mjs'
import { handleText, handleAudio } from './services/chat.mjs'
import { handleCommand, handlePostback } from './commands.mjs'

const WELCOME_MESSAGE =
  '嗨～我是無相界 🌿\n\n' +
  '這裡是帶著金剛經視角的聊天空間，但不用一開始就聊經文。\n\n' +
  '你可以抒發最近卡住的事、問生活或工作上的選擇，也可以純粹想理解佛法在說什麼。想隨便講一句也可以，不用整理好再開口。\n\n' +
  '底下的選單可以隨時用：\n' +
  '🌿 隨意聊聊 — 不用整理，直接從一句話開始\n' +
  '🔄 清除記憶 — 把這之前的對話清掉，從零開始聊\n' +
  '📖 關於 — 這個專案是什麼、為什麼存在\n\n' +
  '想聊什麼，隨時開口就好 😊'

export async function handler(event) {
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body
  const signature = event.headers?.['x-line-signature'] || ''

  if (!verifySignature(body, signature, process.env.LINE_CHANNEL_SECRET)) {
    return { statusCode: 401, body: 'Invalid signature' }
  }

  const parsed = JSON.parse(body)
  const events = parsed.events || []

  if (events.length === 0) {
    return { statusCode: 200, body: 'No events' }
  }

  const lineEvent = events[0]
  const userId = lineEvent.source.userId
  const replyToken = lineEvent.replyToken

  try {
    if (lineEvent.type === 'follow') {
      // User added bot or unblocked — send welcome + re-link Rich Menu
      await replyMessage(replyToken, WELCOME_MESSAGE)
      if (process.env.RICH_MENU_ID) {
        linkRichMenu(userId, process.env.RICH_MENU_ID).catch(() => {})
      }
    } else if (lineEvent.type === 'postback') {
      await handlePostback(userId, replyToken, lineEvent.postback.data)
    } else if (lineEvent.type === 'message') {
      const msg = lineEvent.message

      if (msg.type === 'text' && msg.text.startsWith('@')) {
        await handleCommand(userId, replyToken, msg.text)
      } else if (msg.type === 'text') {
        await handleText(userId, replyToken, msg.text)
      } else if (msg.type === 'audio') {
        await handleAudio(userId, replyToken, msg.id)
      }
    }
  } catch (err) {
    console.error('Handler error:', err)
  }

  return { statusCode: 200, body: 'OK' }
}
