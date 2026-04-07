import { verifySignature, replyMessage, linkRichMenu } from './line.mjs'
import { handleText, handleAudio } from './services/chat.mjs'
import { handleCommand, handlePostback, tryHandleFeedbackText } from './commands.mjs'

const WELCOME_MESSAGE =
  '嗨～我是無相界 🌿\n\n' +
  '我是一個喜歡讀金剛經的朋友，平時陪人聊聊煩惱、聊聊生活，偶爾也一起想想那些沒有標準答案的問題。\n\n' +
  '你可以跟我聊任何事——工作壓力、人際關係、人生方向，或者單純好奇佛法在說什麼，都可以。\n\n' +
  '底下的選單可以隨時用：\n' +
  '🌿 隨意聊聊 — 我分享一句經文，我們從那裡開始\n' +
  '🔄 重新開始 — 清空對話記憶，從頭來過\n' +
  '💬 回饋 — 讓我知道這次聊天有沒有幫上忙\n\n' +
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
        const handled = await tryHandleFeedbackText(userId, replyToken, msg.text)
        if (!handled) await handleText(userId, replyToken, msg.text)
      } else if (msg.type === 'audio') {
        await handleAudio(userId, replyToken, msg.id)
      }
    }
  } catch (err) {
    console.error('Handler error:', err)
  }

  return { statusCode: 200, body: 'OK' }
}
