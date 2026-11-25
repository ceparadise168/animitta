// Drives the real handler, chat service, memory and prompt against an in-memory
// DynamoDB that evaluates conditions and transactions, and checks what the
// model is actually sent and what stays in the table.
import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { createHmac } from 'node:crypto'
import { createFakeDynamoDb } from './support/fake-dynamodb.mjs'

process.env.LINE_CHANNEL_SECRET = 'test-secret'
process.env.MEMORY_TABLE_NAME = 'test-table'
process.env.MAX_RECENT_TURNS = '5'
process.env.SESSION_IDLE_HOURS = '2'
process.env.CONVERSATION_TTL_DAYS = '90'
process.env.LLM_PROVIDER = 'anthropic'
process.env.ANTHROPIC_API_KEY = 'test-key'

const fake = createFakeDynamoDb()
jest.unstable_mockModule('@aws-sdk/client-dynamodb', () => fake.module)
const { rows, hooks } = fake

const chatRequests = []
const lineReplies = []
// LINE accepts each reply token once; a second reply with it fails.
const usedReplyTokens = new Set()
// Like the real summarizer, the result carries the old summary forward.
const echoSummary = async (old, folded) => `${old ? `${old}｜` : ''}摘要：${folded}`
const llm = { summarize: echoSummary, beforeChatReply: async () => {} }
global.fetch = async (url, init) => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  if (String(url).endsWith('/v2/bot/message/reply')) {
    const { replyToken, messages } = JSON.parse(init.body)
    if (usedReplyTokens.has(replyToken)) return { ok: false, status: 400, json: async () => ({ message: 'Invalid reply token' }) }
    usedReplyTokens.add(replyToken)
    lineReplies.push(...messages.map((m) => m.text))
    return ok({})
  }
  if (String(url).startsWith('https://api.line.me/')) return ok({})
  const body = JSON.parse(init.body)
  if (body.system) {
    // The system text as the model reads it, whether sent whole or in blocks.
    chatRequests.push({ ...body, system: [body.system].flat().map((part) => part.text ?? part).join('') })
    await llm.beforeChatReply()
    return ok({ stop_reason: 'end_turn', content: [{ type: 'text', text: '（模型的回覆）' }] })
  }
  const prompt = body.messages[0].content
  const old = prompt.match(/<舊摘要>\n([\s\S]*?)\n<\/舊摘要>/)?.[1] ?? null
  const folded = prompt.match(/<要濃縮的對話>\n([\s\S]*?)\n<\/要濃縮的對話>/)[1]
  try {
    return ok({ content: [{ type: 'text', text: await llm.summarize(old, folded) }] })
  } catch {
    return { ok: false, status: 529, json: async () => ({}) }
  }
}

const { handler } = await import('../lambda/index.mjs')
const memory = await import('../lambda/services/memory.mjs')
const { lineAt, lineIn, lineReply, todaysLine } = await import('../lambda/sutra.mjs')

const USER = 'U-memory'
const PK = `USER#${USER}`
const DAY = 86400
const nowSeconds = () => Math.floor(Date.now() / 1000)
const secondsFromNow = (s) => ({ N: String(nowSeconds() + s) })

let replyTokens = 0
// LINE's timestamp on each event: by default every event is a second after the last.
let lineClock = Date.now()
function send(event, timestamp = (lineClock += 1000)) {
  const body = JSON.stringify({ events: [{ replyToken: `rt-${++replyTokens}`, timestamp, source: { type: 'user', userId: USER }, ...event }] })
  const signature = createHmac('SHA256', 'test-secret').update(body).digest('base64')
  return handler({ body, headers: { 'x-line-signature': signature } })
}
const sendText = (text, timestamp) => send({ type: 'message', message: { type: 'text', text } }, timestamp)
const confirmClear = (timestamp) => send({ type: 'postback', postback: { data: 'confirm:clear' } }, timestamp)

function putTurn(minutesAgo, userText, botText, ttl) {
  const iso = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  for (const [role, suffix, content] of [['user', 'user', userText], ['assistant', 'asst', botText]]) {
    const sk = `TURN#${iso}#${suffix}`
    rows.set(`${PK}|${sk}`, { pk: { S: PK }, sk: { S: sk }, role: { S: role }, content: { S: content }, ...(ttl && { ttl }) })
  }
}
function putSummary(content, ttl) {
  rows.set(`${PK}|SUMMARY`, {
    pk: { S: PK },
    sk: { S: 'SUMMARY' },
    content: { S: content },
    updatedAt: { S: '2026-07-25T06:01:44.532Z' },
    ...(ttl && { ttl }),
  })
}
const summaryRow = () => rows.get(`${PK}|SUMMARY`)
const turnRows = () => [...rows.values()].filter((r) => r.sk.S.startsWith('TURN#'))
const rememberedRows = () => [...rows.values()].filter((r) => r.sk.S !== 'CLEARED')
const everythingSent = (request) => [request.system, ...request.messages.map((m) => m.content)].join('\n')
const expectExpiryInDays = (ttl, days) => expect(Math.abs(Number(ttl.N) - (nowSeconds() + days * DAY))).toBeLessThan(60)

describe('conversation memory, end to end', () => {
  beforeEach(() => {
    rows.clear()
    chatRequests.length = 0
    lineReplies.length = 0
    llm.summarize = echoSummary
    llm.beforeChatReply = async () => {}
    hooks.beforeTransaction = async () => {}
    hooks.queryPageSize = Infinity
    hooks.unprocessedBatches = 0
  })

  describe('sessions', () => {
    it('picks up the previous conversation on the first message after a long gap', async () => {
      putTurn(185, '我媽昨天住院了，我整晚睡不著', '嗯，這個很重')
      putTurn(180, '醫生說要觀察三天', '那這三天你先顧好自己')

      await sendText('她今天出院了')

      const sent = everythingSent(chatRequests[0])
      expect(sent).toContain('我媽昨天住院了')
      expect(sent).toContain('醫生說要觀察三天')
      expect(chatRequests[0].messages.at(-1)).toEqual({ role: 'user', content: '她今天出院了' })
    })

    it('treats the earlier conversation as background, not as live turns, after a long gap', async () => {
      putTurn(185, '我媽昨天住院了', '嗯，這個很重')

      await sendText('她今天出院了')

      expect(chatRequests[0].messages).toEqual([{ role: 'user', content: '她今天出院了' }])
      expect(chatRequests[0].system).toContain('上一段對話')
    })

    it('keeps recent turns as live conversation within a session', async () => {
      putTurn(10, '今天好累', '累爆喔')

      await sendText('對啊')

      expect(chatRequests[0].messages).toEqual([
        { role: 'user', content: '今天好累' },
        { role: 'assistant', content: '累爆喔' },
        { role: 'user', content: '對啊' },
      ])
    })

    it('measures the gap from the newest turn, not the oldest', async () => {
      putTurn(300, '早上的事', '嗯')
      putTurn(10, '剛剛的事', '嗯嗯')

      await sendText('還有')

      expect(chatRequests[0].system).not.toContain('上一段對話')
      expect(everythingSent(chatRequests[0])).toContain('剛剛的事')
    })

    it('folds the previous conversation into the summary once the reply is out', async () => {
      putTurn(185, '我媽昨天住院了', '嗯，這個很重')

      await sendText('她今天出院了')
      await sendText('所以我比較放心了')

      expect(chatRequests[1].system).toContain('我媽昨天住院了')
      expect(chatRequests[1].messages[0]).toEqual({ role: 'user', content: '她今天出院了' })
    })

    it('keeps up to MAX_RECENT_TURNS turns as they were said, and folds only the oldest beyond that', async () => {
      for (let i = 0; i < 3; i++) putTurn(40 - i, `第${i}句`, `回${i}`)

      await sendText('第3句')
      expect(summaryRow()).toBeUndefined()
      expect(turnRows()).toHaveLength(8)

      await sendText('第4句')
      expect(summaryRow()).toBeUndefined()
      expect(turnRows()).toHaveLength(10)

      await sendText('第5句')
      expect(summaryRow().content.S).toContain('第0句')
      expect(summaryRow().content.S).not.toContain('第1句')
      expect(turnRows()).toHaveLength(10)
    })
  })

  describe('what the bot said without the model', () => {
    const press = (data) => send({ type: 'postback', postback: { data } })

    it('reads on when 每日一句 is pressed again, instead of showing the same line', async () => {
      await press('action=daily_line')
      await press('action=daily_line')

      const first = lineIn(lineReplies[0])
      expect(lineReplies).toEqual([lineReply(first, { first: true }), lineReply(lineAt(first.index + 1))])
    })

    // The first reply after a break folds the session before into the summary,
    // today's line with it; the presses after that must still go forward.
    it('keeps reading forward after a break, press after press', async () => {
      const today = todaysLine(lineClock + 1000)
      putTurn(180, '（按了選單的「每日一句」）', lineReply(today, { first: true }))

      await press('action=daily_line')
      await press('action=daily_line')
      await press('action=daily_line')

      expect(lineReplies).toEqual([1, 2, 3].map((ahead) => lineReply(lineAt(today.index + ahead))))
    })

    it('shows a chapter once: 多了解這一段 under the next line of it sends the explanation alone', async () => {
      await press('action=daily_line_more&line=19')
      await press('action=daily_line_next&line=19')
      await press('action=daily_line_more&line=20')

      expect(lineReplies).toEqual([
        expect.stringMatching(/^〈淨心行善分第二十三〉原文：\n\n「復次，須菩提！是法平等/),
        '（模型的回覆）',
        lineReply(lineAt(20)),
        '（模型的回覆）',
      ])
      expect(everythingSent(chatRequests[1])).toContain('所言善法者，如來說即非善法，是名善法。')
    })

    it('remembers the casual-chat opener the user is answering', async () => {
      await send({ type: 'postback', postback: { data: 'action=casual_chat' } })
      const opener = lineReplies[0]

      await sendText('一個人')

      expect(everythingSent(chatRequests[0])).toContain(opener)
    })

    it('remembers a photo it could not read, so the next message can refer to it', async () => {
      await send({ type: 'message', message: { type: 'image', id: 'img1' } })
      expect(lineReplies[0]).toContain('還看不懂')

      await sendText('你覺得那張怎樣')

      const sent = everythingSent(chatRequests[0])
      expect(sent).toContain('（傳了一張圖片）')
      expect(sent).toContain('還看不懂')
    })

    it('answers a sticker through the model', async () => {
      await send({ type: 'message', message: { type: 'sticker', packageId: '446', stickerId: '1988', keywords: ['cry', 'sad'] } })

      expect(chatRequests[0].messages.at(-1)).toEqual({ role: 'user', content: '（傳了一張貼圖：cry、sad）' })
      expect(lineReplies).toEqual(['（模型的回覆）'])
    })
  })

  describe('retention', () => {
    it('keeps each turn for CONVERSATION_TTL_DAYS after it was said', async () => {
      await sendText('嗨')

      for (const row of turnRows()) expectExpiryInDays(row.ttl, 90)
    })

    it('still picks up the last conversation when someone comes back after 45 days', async () => {
      await sendText('我媽昨天住院了')
      const later = Date.now() + 45 * DAY * 1000
      const clock = jest.spyOn(Date, 'now').mockReturnValue(later)
      try {
        await sendText('她今天出院了', later)
      } finally {
        clock.mockRestore()
      }

      expect(everythingSent(chatRequests[1])).toContain('我媽昨天住院了')
    })

    it('creates no summary for a new user, and their next message still works', async () => {
      await sendText('第一次來')
      expect(summaryRow()).toBeUndefined()

      await sendText('第二句')
      expect(lineReplies).toEqual(['（模型的回覆）', '（模型的回覆）'])
    })

    it('forgets an expired summary even before DynamoDB has removed it', async () => {
      putSummary('使用者提過他在準備轉職', secondsFromNow(-60))

      await sendText('嗨')

      expect(chatRequests[0].system).not.toContain('轉職')
    })

    it('does not bring an expired summary back to life when the user writes again', async () => {
      putSummary('使用者提過他在準備轉職', secondsFromNow(-60))

      await sendText('嗨')

      expect(Number(summaryRow().ttl.N)).toBeLessThan(nowSeconds())
    })

    it('keeps the summary for CONVERSATION_TTL_DAYS after the last message, not after it was written', async () => {
      putSummary('使用者提過他在準備轉職', secondsFromNow(3 * DAY))

      await sendText('最近還是很猶豫')

      expect(chatRequests[0].system).toContain('轉職')
      expectExpiryInDays(summaryRow().ttl, 90)
    })

    it('keeps a brand-new summary for CONVERSATION_TTL_DAYS too', async () => {
      putTurn(185, '我媽昨天住院了', '嗯，這個很重')

      await sendText('她今天出院了')

      expect(summaryRow().content.S).toContain('我媽昨天住院了')
      expectExpiryInDays(summaryRow().ttl, 90)
    })

    it('never folds expired turns into a new summary', async () => {
      putTurn(31 * 24 * 60, '我在考慮離婚', '嗯，這個很重', secondsFromNow(-DAY))
      putTurn(185, '今天天氣好好', '真的，適合出去走走')

      await sendText('我出門散步了')
      await sendText('走了一小時')

      const sent = everythingSent(chatRequests[0]) + everythingSent(chatRequests[1])
      expect(sent).toContain('今天天氣好好')
      expect(sent).not.toContain('離婚')
      expect(summaryRow().content.S).not.toContain('離婚')
      expectExpiryInDays(summaryRow().ttl, 90)
    })

    it('does not copy an expired summary into a new one when folding', async () => {
      putSummary('使用者提過他在準備轉職', secondsFromNow(-60))
      putTurn(185, '今天天氣好好', '真的')

      await sendText('我出門散步了')

      expect(summaryRow().content.S).toContain('今天天氣好好')
      expect(summaryRow().content.S).not.toContain('轉職')
    })
  })

  describe('when things go wrong', () => {
    it('keeps what was just said when summarizing fails after a gap', async () => {
      const logged = jest.spyOn(console, 'error').mockImplementation(() => {})
      llm.summarize = async () => {
        throw new Error('overloaded')
      }
      putTurn(185, '我媽昨天住院了', '嗯，這個很重')

      await sendText('她今天出院了')
      await sendText('你還記得我剛剛說什麼嗎')

      expect(lineReplies).toEqual(['（模型的回覆）', '（模型的回覆）'])
      expect(everythingSent(chatRequests[1])).toContain('她今天出院了')
      expect(chatRequests[1].system).not.toContain('上一段對話')
      expect(logged).toHaveBeenCalledWith('Handler error:', expect.any(Error))
      logged.mockRestore()
    })

    it('does not bring memory back when 清除記憶 lands while a fold is being written, and does not page anyone', async () => {
      const logged = jest.spyOn(console, 'error').mockImplementation(() => {})
      putTurn(185, '我在考慮離婚', '嗯，這個很重')
      hooks.beforeTransaction = async () => {
        hooks.beforeTransaction = async () => {}
        await confirmClear()
      }

      await sendText('今天又想了一整天')

      expect(lineReplies).toContain('好的，記憶已清空 ✨ 我們從這裡重新開始')
      expect(rememberedRows()).toEqual([])
      expect(logged).not.toHaveBeenCalledWith('Handler error:', expect.anything())
      logged.mockRestore()
      await sendText('嗨')
      expect(everythingSent(chatRequests[1])).not.toContain('離婚')
    })

    it('forgets a message whose reply was still being written when 清除記憶 landed', async () => {
      putTurn(10, '我在考慮離婚', '嗯')
      llm.beforeChatReply = async () => {
        llm.beforeChatReply = async () => {}
        await confirmClear()
      }

      await sendText('我老公又沒回家')

      expect(turnRows()).toEqual([])
      await sendText('嗨')
      expect(everythingSent(chatRequests[1])).not.toContain('我老公又沒回家')
    })

    it('forgets a message sent before 清除記憶 even when LINE delivers it after the clear', async () => {
      putTurn(10, '我在考慮離婚', '嗯')
      const tappedAt = (lineClock += 1000)
      await confirmClear(tappedAt)

      await sendText('剛剛說太多了', tappedAt - 2000)

      expect(turnRows()).toEqual([])
    })

    it('keeps a message sent after 清除記憶 even when it was being answered before the clear was handled', async () => {
      putTurn(10, '我在考慮離婚', '嗯')
      const tappedAt = (lineClock += 1000)
      llm.beforeChatReply = async () => {
        llm.beforeChatReply = async () => {}
        await confirmClear(tappedAt)
      }

      await sendText('我想重新開始', tappedAt + 1500)

      expect(turnRows().map((r) => r.content.S).sort()).toEqual(['我想重新開始', '（模型的回覆）'].sort())
    })

    it('says so when 清除記憶 could not finish, instead of a generic apology', async () => {
      const logged = jest.spyOn(console, 'error').mockImplementation(() => {})
      putTurn(10, '嗨', '嗨')
      hooks.unprocessedBatches = 100

      await confirmClear()

      expect(lineReplies).toEqual(['記憶還沒清乾淨，等一下再按一次「清除記憶」好嗎'])
      expect(logged).toHaveBeenCalledWith('Handler error:', expect.any(Error))
      logged.mockRestore()
    })

    it('remembers a message that arrived after 清除記憶', async () => {
      putTurn(10, '我在考慮離婚', '嗯')
      await confirmClear()

      await sendText('我想重新開始')
      await sendText('嗨')

      expect(everythingSent(chatRequests[1])).toContain('我想重新開始')
      expect(everythingSent(chatRequests[1])).not.toContain('離婚')
    })

    it('清除記憶 forgets the summary too', async () => {
      putSummary('使用者提過他在準備轉職', secondsFromNow(30 * DAY))
      putTurn(10, '嗨', '嗨')

      await confirmClear()

      expect(rememberedRows()).toEqual([])
    })

    it('清除記憶 reads every page and retries deletes DynamoDB hands back', async () => {
      for (let i = 0; i < 8; i++) putTurn(60 - i, `第${i}句`, `回${i}`)
      hooks.queryPageSize = 3
      hooks.unprocessedBatches = 1

      await confirmClear()

      expect(rememberedRows()).toEqual([])
      expect(lineReplies).toEqual(['好的，記憶已清空 ✨ 我們從這裡重新開始'])
    })

    it('folds a previous session longer than what the model was shown, so none of it comes back as live turns', async () => {
      for (let i = 0; i < 6; i++) putTurn(300 - i, `舊${i}`, `舊回${i}`)

      await sendText('新的一天')
      await sendText('第二句')

      expect(summaryRow().content.S).toContain('舊0')
      expect(chatRequests[1].messages.map((m) => m.content)).toEqual(['新的一天', '（模型的回覆）', '第二句'])
    })

    it('folds a backlog bigger than one transaction a step at a time', async () => {
      for (let i = 0; i < 60; i++) putTurn(100 - i, `第${i}句`, `回${i}`)

      await sendText('還在嗎')

      expect(lineReplies).toEqual(['（模型的回覆）'])
      expect(summaryRow().content.S).toContain('第0句')
      expect(turnRows()).toHaveLength(122 - 98)
    })

    it('loses nothing when two folds of different turns race', async () => {
      putSummary('S0', secondsFromNow(30 * DAY))
      putTurn(300, 'K1', 'K1回')
      const earlier = { endsAt: [...rows.values()].find((r) => r.content.S === 'K1').sk.S.split('#')[1] }
      putTurn(20, 'K2', 'K2回')
      for (let i = 0; i < 5; i++) putTurn(10 - i, `近${i}`, `近回${i}`)
      hooks.beforeTransaction = async () => {
        hooks.beforeTransaction = async () => {}
        await memory.compressOldTurns(USER, { summarize: async (old, ts) => echoSummary(old, ts.map((t) => t.content).join(',')) })
      }

      await memory.archiveSession(USER, earlier, { summarize: async (old, ts) => echoSummary(old, ts.map((t) => t.content).join(',')) })

      const kept = [summaryRow().content.S, ...turnRows().map((r) => r.content.S)].join('|')
      expect(kept).toContain('K1')
      expect(kept).toContain('K2')
    })
  })
})
