// Drives the real handler, chat service, memory and prompt against an in-memory
// DynamoDB table, and checks what the model is actually sent.
import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { createHmac } from 'node:crypto'

process.env.LINE_CHANNEL_SECRET = 'test-secret'
process.env.MEMORY_TABLE_NAME = 'test-table'
process.env.MAX_RECENT_TURNS = '5'
process.env.SESSION_IDLE_HOURS = '2'
process.env.CONVERSATION_TTL_DAYS = '30'
process.env.SUMMARY_TTL_DAYS = '90'
process.env.LLM_PROVIDER = 'anthropic'
process.env.ANTHROPIC_API_KEY = 'test-key'

const rows = new Map()
const rowKey = (key) => `${key.pk.S}|${key.sk.S}`

jest.unstable_mockModule('@aws-sdk/client-dynamodb', () => {
  const command = (type) =>
    class {
      constructor(input) {
        this.type = type
        this.input = input
      }
    }
  const send = async ({ type, input }) => {
    if (type === 'Put') {
      rows.set(rowKey(input.Item), input.Item)
      return {}
    }
    if (type === 'Get') return { Item: rows.get(rowKey(input.Key)) }
    if (type === 'Update') {
      const row = rows.get(rowKey(input.Key))
      const now = Number(input.ExpressionAttributeValues[':now']?.N)
      const expired = row?.ttl && Number(row.ttl.N) <= now
      if (!row || (input.ConditionExpression.includes('#ttl > :now') && expired)) {
        throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' })
      }
      row.ttl = input.ExpressionAttributeValues[':ttl']
      return {}
    }
    if (type === 'Query') {
      const values = input.ExpressionAttributeValues
      const prefix = values[':prefix']?.S ?? ''
      let items = [...rows.values()]
        .filter((r) => r.pk.S === values[':pk'].S && r.sk.S.startsWith(prefix))
        .sort((a, b) => (a.sk.S < b.sk.S ? -1 : 1))
      if (input.ScanIndexForward === false) items.reverse()
      if (input.Limit) items = items.slice(0, input.Limit)
      return { Items: items }
    }
    if (type === 'BatchWrite') {
      for (const request of Object.values(input.RequestItems)[0]) {
        rows.delete(rowKey(request.DeleteRequest.Key))
      }
      return {}
    }
    throw new Error(`fake DynamoDB does not handle ${type}`)
  }
  return {
    DynamoDBClient: class {
      send(cmd) {
        return send(cmd)
      }
    },
    QueryCommand: command('Query'),
    GetItemCommand: command('Get'),
    PutItemCommand: command('Put'),
    UpdateItemCommand: command('Update'),
    BatchWriteItemCommand: command('BatchWrite'),
  }
})

const chatRequests = []
const lineReplies = []
global.fetch = async (url, init) => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  if (String(url).endsWith('/v2/bot/message/reply')) {
    lineReplies.push(JSON.parse(init.body).messages[0].text)
    return ok({})
  }
  if (String(url).startsWith('https://api.line.me/')) return ok({})
  const body = JSON.parse(init.body)
  if (body.system) {
    chatRequests.push(body)
    return ok({ stop_reason: 'end_turn', content: [{ type: 'text', text: '（模型的回覆）' }] })
  }
  const folded = body.messages[0].content.split('需要壓縮的對話：\n')[1]
  return ok({ content: [{ type: 'text', text: `摘要：${folded}` }] })
}

const { handler } = await import('../lambda/index.mjs')

const USER = 'U-memory'
const PK = `USER#${USER}`

function send(event) {
  const body = JSON.stringify({ events: [{ replyToken: 'rt', source: { userId: USER }, ...event }] })
  const signature = createHmac('SHA256', 'test-secret').update(body).digest('base64')
  return handler({ body, headers: { 'x-line-signature': signature } })
}
const sendText = (text) => send({ type: 'message', message: { type: 'text', text } })

const DAY = 86400
const secondsFromNow = (s) => ({ N: String(Math.floor(Date.now() / 1000) + s) })

function putTurn(minutesAgo, userText, botText, ttl) {
  const iso = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  for (const [role, suffix, content] of [['user', 'user', userText], ['assistant', 'asst', botText]]) {
    const sk = `TURN#${iso}#${suffix}`
    rows.set(`${PK}|${sk}`, { pk: { S: PK }, sk: { S: sk }, role: { S: role }, content: { S: content }, ...(ttl && { ttl }) })
  }
}

function putSummary(content, ttl) {
  rows.set(`${PK}|SUMMARY`, { pk: { S: PK }, sk: { S: 'SUMMARY' }, content: { S: content }, updatedAt: { S: '2026-07-25T06:01:44.532Z' }, ...(ttl && { ttl }) })
}
const summaryRow = () => rows.get(`${PK}|SUMMARY`)

const everythingSent = (request) => [request.system, ...request.messages.map((m) => m.content)].join('\n')

describe('conversation memory, end to end', () => {
  beforeEach(() => {
    rows.clear()
    chatRequests.length = 0
    lineReplies.length = 0
  })

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

  it('folds the previous conversation into the summary once the reply is out', async () => {
    putTurn(185, '我媽昨天住院了', '嗯，這個很重')

    await sendText('她今天出院了')
    await sendText('所以我比較放心了')

    expect(chatRequests[1].system).toContain('我媽昨天住院了')
    expect(chatRequests[1].messages[0]).toEqual({ role: 'user', content: '她今天出院了' })
  })

  it('remembers the casual-chat opener the user is answering', async () => {
    await send({ type: 'postback', postback: { data: 'action=casual_chat' } })
    const opener = lineReplies[0]

    await sendText('一個人')

    expect(everythingSent(chatRequests[0])).toContain(opener)
  })

  it('remembers a photo it could not read, so the next message can refer to it', async () => {
    await send({ type: 'message', message: { type: 'image', id: 'img1' } })
    expect(lineReplies[0]).toContain('只能讀文字')

    await sendText('你覺得那張怎樣')

    const sent = everythingSent(chatRequests[0])
    expect(sent).toContain('（傳了一張圖片）')
    expect(sent).toContain('只能讀文字')
  })

  it('answers a sticker through the model', async () => {
    await send({ type: 'message', message: { type: 'sticker', packageId: '446', stickerId: '1988', keywords: ['cry', 'sad'] } })

    expect(chatRequests[0].messages.at(-1)).toEqual({ role: 'user', content: '（傳了一張貼圖：cry、sad）' })
    expect(lineReplies).toEqual(['（模型的回覆）'])
  })


  it('forgets an expired summary even before DynamoDB has removed it', async () => {
    putSummary('使用者提過他在準備轉職', secondsFromNow(-60))

    await sendText('嗨')

    expect(chatRequests[0].system).not.toContain('轉職')
  })

  it('does not bring an expired summary back to life when the user writes again', async () => {
    putSummary('使用者提過他在準備轉職', secondsFromNow(-60))

    await sendText('嗨')

    expect(Number(summaryRow().ttl.N)).toBeLessThan(Math.floor(Date.now() / 1000))
  })

  it('keeps the summary for SUMMARY_TTL_DAYS after the last message, not after it was written', async () => {
    putSummary('使用者提過他在準備轉職', secondsFromNow(3 * DAY))

    await sendText('最近還是很猶豫')

    expect(chatRequests[0].system).toContain('轉職')
    expect(Number(summaryRow().ttl.N)).toBeGreaterThanOrEqual(Number(secondsFromNow(90 * DAY).N) - 5)
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
    expect(Number(summaryRow().ttl.N)).toBeGreaterThanOrEqual(Number(secondsFromNow(90 * DAY).N) - 5)
  })

})
