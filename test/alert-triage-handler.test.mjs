import { describe, it, expect, jest } from '@jest/globals'
import { makeHandler } from '../ops/alert-triage/index.mjs'

const NOW = Date.UTC(2026, 10, 24, 9, 0)
const env = {
  TABLE: 'table',
  BOT_LOG_GROUP: '/aws/lambda/animitta',
  TRIAGE_TOPIC_ARN: 'arn:triage',
  ROUTINE_URL_PARAM: '/animitta/alert-routine/url',
  ROUTINE_TOKEN_PARAM: '/animitta/alert-routine/token',
  DEPLOYED_PARAM: '/animitta/deployed',
}
const alarm = (name, state = 'ALARM') => ({
  Records: [{ Sns: { Message: JSON.stringify({ AlarmName: name, NewStateValue: state, StateChangeTime: '2026-11-24T09:00:00.000+0000' }) } }],
})

// An in-memory table that honours the one condition the handler writes with.
function fakeTable() {
  const rows = new Map()
  return {
    rows,
    send: jest.fn(async ({ input }) => {
      const key = input.Item.sk.S
      const held = rows.get(key)
      if (input.ConditionExpression && held && Number(held) >= Number(input.ExpressionAttributeValues[':now'].N)) {
        throw Object.assign(new Error('held'), { name: 'ConditionalCheckFailedException' })
      }
      rows.set(key, input.Item.ttl.N)
      return {}
    }),
  }
}

function setUp({ lines, fire = { ok: true, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/session_1' }) } }) {
  const db = fakeTable()
  const sns = { send: jest.fn().mockResolvedValue({}) }
  const params = {
    [env.ROUTINE_URL_PARAM]: 'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire',
    [env.ROUTINE_TOKEN_PARAM]: 'sk-ant-oat01-test',
    [env.DEPLOYED_PARAM]: JSON.stringify({ commit: 'abc1234', at: '2026-11-24T08:00:00Z', by: 'actions', infraTree: 'x' }),
  }
  const ssm = { send: jest.fn(async ({ input }) => ({ Parameter: { Value: params[input.Name] } })) }
  const logs = { send: jest.fn().mockResolvedValue({ events: lines.map((message, i) => ({ timestamp: NOW - i * 60_000, message })) }) }
  const fetch = jest.fn().mockResolvedValue(fire)
  const handler = makeHandler({ logs, db, sns, ssm, fetch, env, now: () => NOW })
  const emails = () => sns.send.mock.calls.map(([command]) => command.input)
  return { handler, db, fetch, emails }
}

const codeError = "Handler error: TypeError: Cannot read properties of undefined (reading '我好累')\n    at foldIntoSummary (file:///var/task/services/memory.mjs:172:31)"
const keyError = 'Handler error: Error: Anthropic chat failed: 401 authentication_error'

describe('alert triage', () => {
  it('wakes Claude for a code error with only the summary, and emails the session link', async () => {
    const { handler, fetch, emails } = setUp({ lines: [codeError] })

    await handler(alarm('animitta-handler-failures'))

    const [url, request] = fetch.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/claude_code/routines/trig_1/fire')
    expect(request.headers.Authorization).toBe('Bearer sk-ant-oat01-test')
    const sent = JSON.parse(JSON.parse(request.body).text)
    expect(sent.deployed).toEqual({ commit: 'abc1234', at: '2026-11-24T08:00:00Z', by: 'actions' })
    expect(sent.causes[0]).toMatchObject({ kind: 'code', errorClass: 'TypeError', frames: ['services/memory.mjs:172'] })
    expect(request.body).not.toContain('我好累')
    const [email] = emails()
    expect(email.Message).toContain('Claude 正在查：https://claude.ai/code/session_1')
    expect(email.Message).not.toContain('我好累')
    expect(email.Subject).toMatch(/^[\x20-\x7e]+$/)
  })

  it('emails the human step for a rejected key, without waking Claude', async () => {
    const { handler, fetch, emails } = setUp({ lines: [keyError] })

    await handler(alarm('animitta-handler-failures'))

    expect(fetch).not.toHaveBeenCalled()
    expect(emails()[0].Message).toContain('金鑰失效')
    expect(emails()[0].Message).toContain('沒有叫 Claude')
  })

  it('emails a cause once in six hours, however often the alarm flips', async () => {
    const { handler, emails } = setUp({ lines: [keyError] })

    await handler(alarm('animitta-handler-failures'))
    await handler(alarm('animitta-handler-failures'))

    expect(emails()).toHaveLength(1)
  })

  it('wakes Claude at most once in six hours', async () => {
    const { handler, fetch, db } = setUp({ lines: [codeError] })

    await handler(alarm('animitta-handler-failures'))
    db.rows.delete('EMAIL#code:TypeError:services/memory.mjs:172')
    await handler(alarm('animitta-handler-failures'))

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('says when waking Claude failed, and lets the next alarm try again', async () => {
    const { handler, fetch, db, emails } = setUp({ lines: [codeError], fire: { ok: false, status: 401 } })

    await handler(alarm('animitta-handler-failures'))
    db.rows.delete('EMAIL#code:TypeError:services/memory.mjs:172')
    await handler(alarm('animitta-handler-failures'))

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(emails()[0].Message).toContain('叫 Claude 失敗（HTTP 401）')
  })

  it('tells him people were still answered when the backup took over', async () => {
    const { handler, fetch, emails } = setUp({ lines: ['Provider fallback: Anthropic chat failed: 401 authentication_error -> Bedrock chat ok'] })

    await handler(alarm('animitta-answered-by-backup'))

    expect(fetch).not.toHaveBeenCalled()
    expect(emails()[0].Message).toContain('照常收到回覆，是 Bedrock 備援回的')
  })

  it('ignores an alarm going back to OK, other alarms, and messages that are not alarms', async () => {
    const { handler, emails } = setUp({ lines: [keyError] })

    await handler(alarm('animitta-handler-failures', 'OK'))
    await handler(alarm('animitta-voice-limit-reached'))
    await handler({ Records: [{ Sns: { Message: '無相界的 ANTHROPIC_API_KEY 7 天後到期' } }] })

    expect(emails()).toHaveLength(0)
  })

  it('treats an alarm with no log lines as a test: one email, no Claude', async () => {
    const { handler, fetch, emails } = setUp({ lines: [] })

    await handler(alarm('animitta-handler-failures'))

    expect(fetch).not.toHaveBeenCalled()
    expect(emails()[0].Message).toContain('找不到對應的錯誤行')
  })
})
