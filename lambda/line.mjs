import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifySignature(body, signature, secret) {
  const hash = createHmac('SHA256', secret).update(body).digest('base64')
  try {
    return timingSafeEqual(Buffer.from(hash), Buffer.from(signature))
  } catch {
    return false
  }
}

export async function downloadContent(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } }
  )
  if (!res.ok) throw new Error(`LINE download failed: ${res.status}`)
  return res.arrayBuffer()
}

export async function showLoadingIndicator(userId) {
  await fetch('https://api.line.me/v2/bot/chat/loading', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ chatId: userId }),
  })
}

export async function replyMessage(replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  })
  if (!res.ok) throw new Error(`LINE reply failed: ${res.status}`)
}

/**
 * Reply with a text message and Quick Reply buttons.
 * @param {string} replyToken
 * @param {string} text
 * @param {Array<{label: string, data: string}>} items - postback quick reply items
 */
export async function replyWithQuickReply(replyToken, text, items) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [
        {
          type: 'text',
          text,
          quickReply: {
            items: items.map((item) => ({
              type: 'action',
              action: {
                type: 'postback',
                label: item.label,
                data: item.data,
                displayText: item.label,
              },
            })),
          },
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`LINE quick reply failed: ${res.status}`)
}
