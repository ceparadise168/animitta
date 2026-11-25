import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { summarize, needsClaude, forClaude, explain } from './summary.mjs'

// The bot's alarms this reads, the log lines behind each, and how far back
// those lines can be from the moment the alarm went off.
const ALARMS = {
  // From Invoke Error on: the Lambda runtime's own lines when the code throws
  // outside the handler, cannot load, or the process dies, which the alarm
  // counts as uncaught errors.
  'animitta-handler-failures': {
    pattern:
      '?"Handler error" ?"Task timed out" ?"Invoke Error" ?"Uncaught Exception" ?"Unhandled Promise Rejection" ?"Runtime.ImportModuleError" ?"Runtime.UserCodeSyntaxError" ?"Runtime exited"',
    lookbackMinutes: 10,
  },
  'animitta-answered-by-backup': { pattern: '"Provider fallback"', lookbackMinutes: 65 },
}
const QUIET_HOURS = 6
const MAX_LINES = 200

export function makeHandler({ logs, db, sns, ssm, fetch, env, now = Date.now }) {
  // One email per cause, and one Claude run, per QUIET_HOURS: an outage can
  // flip the alarm on and off many times.
  async function firstIn(quietKey) {
    const at = Math.floor(now() / 1000)
    try {
      await db.send(
        new PutItemCommand({
          TableName: env.TABLE,
          Item: { pk: { S: 'OPS#ALERT' }, sk: { S: quietKey }, ttl: { N: String(at + QUIET_HOURS * 3600) } },
          ConditionExpression: 'attribute_not_exists(pk) OR #ttl < :now',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':now': { N: String(at) } },
        })
      )
      return true
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') return false
      throw err
    }
  }

  // A Claude run that never started should not hold the quiet hours.
  async function release(quietKey) {
    await db.send(
      new PutItemCommand({
        TableName: env.TABLE,
        Item: { pk: { S: 'OPS#ALERT' }, sk: { S: quietKey }, ttl: { N: String(Math.floor(now() / 1000) - 1) } },
      })
    )
  }

  // What runs now, as the last deploy wrote it: commit, time, and who.
  async function deployed() {
    try {
      const { commit, at, by } = JSON.parse((await ssm.send(new GetParameterCommand({ Name: env.DEPLOYED_PARAM }))).Parameter.Value)
      return { commit, at, by }
    } catch {
      return null
    }
  }

  async function failureLines(pattern, from, to) {
    const events = []
    let nextToken
    do {
      const page = await logs.send(
        new FilterLogEventsCommand({ logGroupName: env.BOT_LOG_GROUP, filterPattern: pattern, startTime: from, endTime: to, nextToken })
      )
      events.push(...(page.events ?? []).map(({ timestamp, message }) => ({ timestamp, message: message ?? '' })))
      nextToken = page.nextToken
    } while (nextToken && events.length < MAX_LINES)
    return events
  }

  async function wakeClaude(alarmName, causes, window) {
    if (!(await firstIn('ROUTINE'))) return { skipped: `${QUIET_HOURS} 小時內已經叫過一次` }
    const param = async (name, decrypt) =>
      (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: decrypt }))).Parameter.Value
    try {
      const [url, token, live] = await Promise.all([param(env.ROUTINE_URL_PARAM, false), param(env.ROUTINE_TOKEN_PARAM, true), deployed()])
      const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'experimental-cc-routine-2026-04-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: JSON.stringify({ alarm: alarmName, window, deployed: live, causes }) }),
      })
      if (!res.ok) {
        await release('ROUTINE')
        return { failed: `HTTP ${res.status}` }
      }
      // Started either way; only the link may be missing.
      const session = await res.json().then((body) => body.claude_code_session_url, () => null)
      return { url: session, started: true }
    } catch (err) {
      await release('ROUTINE')
      return { failed: err.name ?? 'error' }
    }
  }

  return async function handler(event) {
    for (const record of event.Records ?? []) {
      const alarm = parseAlarm(record.Sns?.Message)
      if (!alarm) continue
      const { pattern, lookbackMinutes } = ALARMS[alarm.name]
      const window = { from: alarm.changedAt - lookbackMinutes * 60_000, to: alarm.changedAt + 60_000 }
      const causes = summarize(await failureLines(pattern, window.from, window.to))
      const onBackup = alarm.name === 'animitta-answered-by-backup'

      const quietKeys = causes.length ? causes.map((cause) => `EMAIL#${cause.signature}`) : [`EMAIL#none:${alarm.name}`]
      const fresh = []
      for (const key of quietKeys) if (await firstIn(key)) fresh.push(key)
      if (!fresh.length) continue

      const claude = !onBackup && needsClaude(causes) ? await wakeClaude(alarm.name, causes, isoWindow(window)) : null
      // Only counts and causes, never the lines themselves.
      console.log(JSON.stringify({ alarm: alarm.name, causes: causes.map(({ signature, count }) => ({ signature, count })), claude }))
      try {
        await sns.send(
          new PublishCommand({ TopicArn: env.TRIAGE_TOPIC_ARN, Subject: subjectOf(alarm.name, causes), Message: bodyOf(alarm, causes, onBackup, claude) })
        )
      } catch (err) {
        for (const key of fresh) await release(key)
        throw err
      }
    }
  }
}

function parseAlarm(message) {
  let alarm
  try {
    alarm = JSON.parse(message)
  } catch {
    return null
  }
  if (alarm?.NewStateValue !== 'ALARM' || !ALARMS[alarm.AlarmName]) return null
  // CloudWatch writes the offset as +0000, which Date.parse does not read.
  const changedAt = Date.parse(String(alarm.StateChangeTime).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isFinite(changedAt) ? { name: alarm.AlarmName, changedAt } : null
}

const isoWindow = ({ from, to }) => ({ from: new Date(from).toISOString(), to: new Date(to).toISOString() })

const taipei = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(11, 16)

// SNS takes a short subject; the Chinese is in the body.
function subjectOf(alarmName, causes) {
  const top = causes[0]
  const what = top ? [top.kind, top.service, top.op, top.status].filter(Boolean).join(' ') : 'no matching log lines'
  return `[animitta] ${alarmName.replace('animitta-', '')}: ${what}`.slice(0, 99)
}

function bodyOf(alarm, causes, onBackup, claude) {
  const lines = [`無相界警報（台北時間 ${taipei(alarm.changedAt)}）`, '']
  if (!causes.length) {
    lines.push('這段時間的紀錄裡找不到對應的錯誤行。到 CloudWatch Logs /aws/lambda/animitta 看看。')
  }
  causes.forEach((cause, i) => {
    const step = explain(cause)
    if (i > 0) lines.push('', '另外：')
    lines.push(`發生什麼事：${step.what}`)
    lines.push(`使用者看到：${onBackup ? '照常收到回覆，是 Bedrock 備援回的。' : step.users}`)
    const action = onBackup && forClaude(cause)
      ? '到 CloudWatch Logs /aws/lambda/animitta 搜尋 "Provider fallback" 看那一行。'
      : forClaude(cause) && !claude?.started
        ? '這次沒有叫到 Claude（原因在信末），請到 CloudWatch Logs /aws/lambda/animitta 看，或請 Claude 查。'
        : step.action
    lines.push(`你要做的：${action}${step.phone ? '（手機可以處理）' : '（需要電腦）'}`)
    lines.push(`次數：${cause.count} 次（${taipei(cause.first)}–${taipei(cause.last)}）`)
  })
  lines.push('')
  if (claude?.url) lines.push(`Claude 正在查：${claude.url}`)
  else if (claude?.started) lines.push('Claude 已經開始查，但沒拿到連結：到 claude.ai/code 看最新的工作階段。')
  else if (claude?.skipped) lines.push(`Claude 這次沒叫：${claude.skipped}。`)
  else if (claude?.failed) lines.push(`叫 Claude 失敗（${claude.failed}）。如果是 401，排程任務的 token 可能失效了，要你重產一把。`)
  else if (onBackup) lines.push('備援接手的警報不叫 Claude：使用者照常收到回覆。')
  else lines.push('沒有叫 Claude：這類原因改程式修不好。')
  return lines.join('\n')
}

export const handler = makeHandler({
  logs: new CloudWatchLogsClient({}),
  db: new DynamoDBClient({}),
  sns: new SNSClient({}),
  ssm: new SSMClient({}),
  fetch: globalThis.fetch,
  env: process.env,
})
