/**
 * The LINE rich menu: four equal buttons drawn in scripts/richmenu.jpg.
 *
 *   node scripts/setup-richmenu.mjs                  create the menu, print its id
 *   node scripts/setup-richmenu.mjs switch FROM TO   make TO the default and move
 *                                                    everyone linked to FROM onto it
 *
 * People are linked one by one when they add the bot (lambda/index.mjs links
 * RICH_MENU_ID on follow), and a link beats the default, so a new menu reaches
 * them only through switch. Set RICH_MENU_ID in .env to TO and deploy before
 * switching: switch moves only the people linked to FROM at that moment, so
 * anyone the old setting links afterwards would stay on FROM. Menus are never
 * deleted here: going back is the same two steps with the ids the other way round.
 *
 * Requires .env with LINE_CHANNEL_ACCESS_TOKEN.
 */

import { readFile } from 'fs/promises'
import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../.env') })

const API = 'https://api.line.me'
const AUTH = { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
const IMAGE = resolve(__dirname, 'richmenu.jpg')

// Left to right, as the image draws them; each takes a quarter of the width.
// 隨意聊聊 opens with a question, so the keyboard comes up; 每日一句 only folds the
// menu away, since under the line its two buttons are the likely next step.
const BUTTONS = [
  { type: 'postback', data: 'action=casual_chat', displayText: '隨意聊聊', inputOption: 'openKeyboard' },
  { type: 'postback', data: 'action=daily_line', displayText: '每日一句', inputOption: 'closeRichMenu' },
  { type: 'message', text: '@清除記憶' },
  { type: 'message', text: '@關於' },
]

async function main([command, from, to]) {
  if (command === 'switch') {
    if (!from || !to) throw new Error('Usage: node scripts/setup-richmenu.mjs switch FROM TO')
    return switchMenu(from, to)
  }
  if (command) throw new Error(`Unknown command: ${command}`)

  const image = await readFile(IMAGE)
  console.log('1. Creating rich menu...')
  const richMenuId = await createRichMenu()
  console.log(`   ${richMenuId}`)
  console.log(`2. Uploading ${IMAGE} (${(image.length / 1024).toFixed(0)} KB)...`)
  await call(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'image/jpeg' },
    body: image,
  })
  console.log(`\nCreated, not live yet. Next:\n  1. set RICH_MENU_ID=${richMenuId} in .env and deploy\n  2. node scripts/setup-richmenu.mjs switch ${process.env.RICH_MENU_ID || 'OLD_ID'} ${richMenuId}`)
}

async function createRichMenu() {
  const width = 2500 / BUTTONS.length
  const res = await call(`${API}/v2/bot/richmenu`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      size: { width: 2500, height: 843 },
      selected: true,
      name: '無相界 Rich Menu',
      chatBarText: '選單',
      areas: BUTTONS.map((action, i) => ({ bounds: { x: i * width, y: 0, width, height: 843 }, action })),
    }),
  })
  return (await res.json()).richMenuId
}

async function switchMenu(from, to) {
  if (process.env.RICH_MENU_ID !== to) {
    throw new Error(`Set RICH_MENU_ID=${to} in .env and deploy first, so nobody who adds the bot meanwhile is linked to ${from}`)
  }
  console.log(`1. Making ${to} the default...`)
  await call(`${API}/v2/bot/user/all/richmenu/${to}`, { method: 'POST', headers: AUTH })

  // At most 3 batch requests an hour, so check it first; validation is not limited.
  // The resume key makes a retried request continue the first one instead of starting over.
  const batch = JSON.stringify({ operations: [{ type: 'link', from, to }], resumeRequestKey: `${from}-to-${to}`.slice(0, 100) })
  const json = { ...AUTH, 'Content-Type': 'application/json' }
  console.log(`2. Moving everyone linked to ${from} onto it...`)
  await call(`${API}/v2/bot/richmenu/validate/batch`, { method: 'POST', headers: json, body: batch })
  const res = await call(`${API}/v2/bot/richmenu/batch`, { method: 'POST', headers: json, body: batch })
  const requestId = res.headers.get('x-line-request-id')
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000))
    const progress = await (await call(`${API}/v2/bot/richmenu/progress/batch?requestId=${requestId}`, { headers: AUTH })).json()
    console.log(`   ${progress.phase}`)
    if (progress.phase === 'succeeded') break
    if (progress.phase === 'failed') throw new Error(`Batch ${requestId} failed`)
  }
  console.log(`\nDone: ${to} is the default and everyone linked to ${from} is on it.`)
}

async function call(url, init) {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url}: ${res.status} ${await res.text()}`)
  return res
}

main(process.argv.slice(2)).catch((err) => {
  console.error('Failed:', err.message)
  process.exit(1)
})
