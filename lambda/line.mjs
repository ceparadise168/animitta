import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifySignature(body, signature, secret) {
  const hash = createHmac('SHA256', secret).update(body).digest('base64')
  try {
    return timingSafeEqual(Buffer.from(hash), Buffer.from(signature))
  } catch {
    return false
  }
}

export async function linkRichMenu(userId, richMenuId) {
  const res = await fetch(
    `https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    }
  )
  if (!res.ok) throw new Error(`LINE link rich menu failed: ${res.status}`)
}

// LINE shows the animation for loadingSeconds (5 to 60, in steps of 5; 20
// when left out) or until the bot's next message arrives. A later call
// replaces the time.
export async function showLoadingIndicator(userId, loadingSeconds) {
  const res = await fetch('https://api.line.me/v2/bot/chat/loading/start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ chatId: userId, ...(loadingSeconds && { loadingSeconds }) }),
  })
  if (!res.ok) throw new Error(`LINE loading indicator failed: ${res.status}`)
}

/**
 * The file a user sent. LINE answers 202 while it is still preparing a large
 * audio or video file, so this asks again until the file is ready or the
 * deadline (a Date.now() value) passes.
 */
export async function downloadContent(messageId, deadline) {
  for (;;) {
    const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    })
    if (res.status === 200) return Buffer.from(await res.arrayBuffer())
    if (res.status !== 202) throw new Error(`LINE content download failed: ${res.status}`)
    if (Date.now() >= deadline) throw new Error('LINE content was still being prepared at the deadline')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

// text is one message, or several (LINE takes up to five in one reply).
export async function replyMessage(replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [text].flat().map((t) => ({ type: 'text', text: t })),
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
                ...(item.inputOption && { inputOption: item.inputOption }),
              },
            })),
          },
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`LINE quick reply failed: ${res.status}`)
}

