import { verifySignature } from './line.mjs'
import { handleText, handleAudio } from './services/chat.mjs'

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
  if (lineEvent.type !== 'message') {
    return { statusCode: 200, body: 'Ignored' }
  }

  const userId = lineEvent.source.userId
  const replyToken = lineEvent.replyToken
  const msg = lineEvent.message

  try {
    if (msg.type === 'text') {
      await handleText(userId, replyToken, msg.text)
    } else if (msg.type === 'audio') {
      await handleAudio(userId, replyToken, msg.id)
    }
  } catch (err) {
    console.error('Handler error:', err)
  }

  return { statusCode: 200, body: 'OK' }
}
