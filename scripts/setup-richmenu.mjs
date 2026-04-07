/**
 * One-time script to create and set up the LINE Rich Menu.
 *
 * Usage: node scripts/setup-richmenu.mjs
 *
 * Requires .env with LINE_CHANNEL_ACCESS_TOKEN
 */

import { createCanvas } from 'canvas'
import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../.env') })

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN
const API = 'https://api.line.me'

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
}

async function main() {
  console.log('1. Creating Rich Menu...')
  const richMenuId = await createRichMenu()
  console.log(`   Rich Menu ID: ${richMenuId}`)

  console.log('2. Generating image...')
  const imageBuffer = generateImage()

  console.log('3. Uploading image...')
  await uploadImage(richMenuId, imageBuffer)

  console.log('4. Setting as default...')
  await setDefault(richMenuId)

  console.log('\nDone! Rich Menu is live.')
}

async function createRichMenu() {
  const res = await fetch(`${API}/v2/bot/richmenu`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      size: { width: 2500, height: 843 },
      selected: true,
      name: '無相界 Rich Menu',
      chatBarText: '選單',
      areas: [
        {
          bounds: { x: 0, y: 0, width: 833, height: 843 },
          action: { type: 'message', text: '@隨意聊聊' },
        },
        {
          bounds: { x: 833, y: 0, width: 834, height: 843 },
          action: { type: 'message', text: '@重新開始' },
        },
        {
          bounds: { x: 1667, y: 0, width: 833, height: 843 },
          action: { type: 'message', text: '@回饋' },
        },
      ],
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Create failed: ${JSON.stringify(data)}`)
  return data.richMenuId
}

function generateImage() {
  const W = 2500
  const H = 843
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')

  // Background — deep warm dark
  const bg = ctx.createLinearGradient(0, 0, W, H)
  bg.addColorStop(0, '#2a2520')
  bg.addColorStop(0.4, '#1e1b17')
  bg.addColorStop(0.7, '#252119')
  bg.addColorStop(1, '#2a2520')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)

  // Subtle radial glow
  const glow = ctx.createRadialGradient(W * 0.2, H * 0.5, 0, W * 0.2, H * 0.5, W * 0.4)
  glow.addColorStop(0, 'rgba(62, 55, 45, 0.5)')
  glow.addColorStop(1, 'transparent')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, W, H)

  // Top accent line
  const lineGrad = ctx.createLinearGradient(W * 0.1, 0, W * 0.9, 0)
  lineGrad.addColorStop(0, 'transparent')
  lineGrad.addColorStop(0.5, 'rgba(196, 184, 154, 0.3)')
  lineGrad.addColorStop(1, 'transparent')
  ctx.strokeStyle = lineGrad
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(W * 0.1, 1)
  ctx.lineTo(W * 0.9, 1)
  ctx.stroke()

  // Vertical dividers
  for (const x of [833, 1667]) {
    const divGrad = ctx.createLinearGradient(0, H * 0.25, 0, H * 0.75)
    divGrad.addColorStop(0, 'transparent')
    divGrad.addColorStop(0.5, 'rgba(196, 184, 154, 0.15)')
    divGrad.addColorStop(1, 'transparent')
    ctx.strokeStyle = divGrad
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, H * 0.25)
    ctx.lineTo(x, H * 0.75)
    ctx.stroke()
  }

  // Menu items
  const items = [
    { emoji: '🌿', label: '隨意聊聊', sub: 'EXPLORE', cx: 416 },
    { emoji: '🔄', label: '重新開始', sub: 'RESTART', cx: 1250 },
    { emoji: '💬', label: '回饋', sub: 'FEEDBACK', cx: 2083 },
  ]

  for (const item of items) {
    // Emoji — large and prominent
    ctx.font = '180px serif'
    ctx.textAlign = 'center'
    ctx.fillStyle = '#ffffff'
    ctx.fillText(item.emoji, item.cx, H * 0.42)

    // Chinese label — bold and readable
    ctx.font = 'bold 96px sans-serif'
    ctx.fillStyle = '#c4b89a'
    ctx.fillText(item.label, item.cx, H * 0.68)

    // English sub-label
    ctx.font = '40px sans-serif'
    ctx.fillStyle = 'rgba(196, 184, 154, 0.4)'
    ctx.letterSpacing = '3px'
    ctx.fillText(item.sub, item.cx, H * 0.82)
  }

  return canvas.toBuffer('image/png')
}

async function uploadImage(richMenuId, imageBuffer) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'image/png',
      },
      body: imageBuffer,
    }
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Upload failed: ${text}`)
  }
}

async function setDefault(richMenuId) {
  const res = await fetch(
    `${API}/v2/bot/user/all/richmenu/${richMenuId}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    }
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Set default failed: ${text}`)
  }
}

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
