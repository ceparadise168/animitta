// Drives the real handler, voice, chat and memory code against an in-memory
// DynamoDB, S3 and Transcribe, and checks what the user hears back, what the
// model is sent, what the monthly counter says and that no recording is left.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import { createHmac } from 'node:crypto'
import { createFakeDynamoDb } from './support/fake-dynamodb.mjs'

process.env.LINE_CHANNEL_SECRET = 'test-secret'
process.env.MEMORY_TABLE_NAME = 'test-table'
process.env.LLM_PROVIDER = 'anthropic'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.VOICE_BUCKET_NAME = 'voice-bucket'
process.env.VOICE_MINUTES_PER_MONTH = '30'
process.env.VOICE_MINUTES_ALL_USERS_PER_MONTH = '1500'

const fake = createFakeDynamoDb()
jest.unstable_mockModule('@aws-sdk/client-dynamodb', () => fake.module)
const { rows, hooks } = fake

// S3: objects by key.
const objects = new Map()
const s3Command = (type) => class { constructor(input) { this.type = type; this.input = input } }
jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
  S3Client: class {
    async send({ type, input }) {
      if (input.Bucket !== 'voice-bucket') throw new Error(`unexpected bucket ${input.Bucket}`)
      if (type === 'Put') objects.set(input.Key, input.Body)
      if (type === 'Get') {
        if (!objects.has(input.Key)) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
        return { Body: { transformToString: async () => String(objects.get(input.Key)) } }
      }
      if (type === 'DeleteMany') for (const { Key } of input.Delete.Objects) objects.delete(Key)
      return {}
    }
  },
  PutObjectCommand: s3Command('Put'),
  GetObjectCommand: s3Command('Get'),
  DeleteObjectsCommand: s3Command('DeleteMany'),
}))

// Transcribe: a job finishes on its second status check, with what `speech`
// says. Like the real service, it refuses to delete a job still in progress.
const jobs = new Map()
const startedJobs = []
const speech = { transcript: '最近工作壓力很大，晚上睡不著', fails: false, neverFinishes: false }
jest.unstable_mockModule('@aws-sdk/client-transcribe', () => ({
  TranscribeClient: class {
    async send({ type, input }) {
      if (type === 'Start') {
        const audioKey = input.Media.MediaFileUri.replace('s3://voice-bucket/', '')
        if (!objects.has(audioKey)) throw new Error('recording missing from S3')
        startedJobs.push(input)
        jobs.set(input.TranscriptionJobName, { input, checks: 0, status: 'IN_PROGRESS' })
        return {}
      }
      const job = jobs.get(input.TranscriptionJobName)
      if (type === 'Delete') {
        if (job.status === 'IN_PROGRESS') throw Object.assign(new Error('job in progress'), { name: 'BadRequestException' })
        return jobs.delete(input.TranscriptionJobName), {}
      }
      job.checks++
      if (!speech.neverFinishes && job.checks >= 2) job.status = speech.fails ? 'FAILED' : 'COMPLETED'
      if (job.status === 'COMPLETED') {
        objects.set(job.input.OutputKey, JSON.stringify({ results: { transcripts: [{ transcript: speech.transcript }] } }))
      }
      return { TranscriptionJob: { TranscriptionJobStatus: job.status, FailureReason: speech.fails ? 'bad audio' : undefined } }
    }
  },
  StartTranscriptionJobCommand: s3Command('Start'),
  GetTranscriptionJobCommand: s3Command('Get'),
  DeleteTranscriptionJobCommand: s3Command('Delete'),
}))

// Organizations: what this account's effective AI services opt-out policy says,
// or the error the call fails with.
const account = { optOut: null, error: null, hangs: false }
const optedOutForAll = { services: { default: { opt_out_policy: 'optOut' } } }
jest.unstable_mockModule('@aws-sdk/client-organizations', () => ({
  OrganizationsClient: class {
    async send({ input }, options = {}) {
      if (input.PolicyType !== 'AISERVICES_OPT_OUT_POLICY') throw new Error(`unexpected policy type ${input.PolicyType}`)
      if (account.hangs) {
        return new Promise((_, reject) =>
          options.abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })))
        )
      }
      if (account.error) throw Object.assign(new Error(account.error), { name: account.error })
      return { EffectivePolicy: { PolicyContent: JSON.stringify(account.optOut) } }
    }
  },
  DescribeEffectivePolicyCommand: s3Command('DescribeEffectivePolicy'),
}))

const chatRequests = []
const lineReplies = []
const loadingCalls = []
const line = { notReadyFor: 0 }
const llm = { summaryFails: false }
global.fetch = async (url, init = {}) => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  url = String(url)
  if (url.endsWith('/v2/bot/message/reply')) {
    lineReplies.push(JSON.parse(init.body).messages[0].text)
    return ok({})
  }
  if (url.endsWith('/v2/bot/chat/loading/start')) {
    loadingCalls.push(JSON.parse(init.body))
    return ok({})
  }
  if (url.startsWith('https://api-data.line.me/v2/bot/message/')) {
    if (line.notReadyFor > 0) return line.notReadyFor--, { ok: true, status: 202 }
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('m4a bytes').buffer }
  }
  if (url.startsWith('https://api.line.me/')) return ok({})
  const body = JSON.parse(init.body)
  if (body.system) chatRequests.push(body)
  else if (llm.summaryFails) return { ok: false, status: 529, json: async () => ({}) }
  return ok({ stop_reason: 'end_turn', content: [{ type: 'text', text: '（模型的回覆）' }] })
}

const { handler } = await import('../lambda/index.mjs')
const { transcribe } = await import('../lambda/services/transcribe.mjs')

const USER = 'U-voice'
const PK = `USER#${USER}`
// The clock starts at 2026-11-23 10:00 in Taipei and runs at real speed, so a
// message sent "now" has its full minute to be answered.
const NOV = Date.parse('2026-11-23T02:00:00Z')
let replyTokens = 0
function sendVoice({ seconds = 12, at = Date.now(), provider = 'line', user = USER } = {}) {
  const message = { type: 'audio', id: `m-${++replyTokens}`, duration: seconds * 1000, contentProvider: { type: provider } }
  const body = JSON.stringify({ events: [{ type: 'message', replyToken: `rt-${replyTokens}`, timestamp: at, source: { type: 'user', userId: user }, message }] })
  const signature = createHmac('SHA256', 'test-secret').update(body).digest('base64')
  return handler({ body, headers: { 'x-line-signature': signature } })
}
const counted = (pk, month) => Number(rows.get(`${pk}|VOICE#${month}`)?.usedSeconds.N ?? 0)
const usedSeconds = (month, user = USER) => counted(`USER#${user}`, month)
const everyoneSeconds = (month) => counted('ALL_USERS', month)
function setCounter(pk, month, seconds) {
  rows.set(`${pk}|VOICE#${month}`, { pk: { S: pk }, sk: { S: `VOICE#${month}` }, usedSeconds: { N: String(seconds) } })
}
const setUsed = (month, seconds) => setCounter(PK, month, seconds)
const setEveryone = (month, seconds) => setCounter('ALL_USERS', month, seconds)
// Earlier exchanges a few minutes ago, so this one pushes the oldest into the summary.
function putTurns(count) {
  for (let i = 0; i < count; i++) {
    const iso = new Date(Date.now() - (count - i) * 60_000).toISOString()
    for (const [role, suffix] of [['user', 'user'], ['assistant', 'asst']]) {
      const sk = `TURN#${iso}#${suffix}`
      rows.set(`${PK}|${sk}`, { pk: { S: PK }, sk: { S: sk }, role: { S: role }, content: { S: `第 ${i + 1} 句` } })
    }
  }
}
const userTurns = () => [...rows.values()].filter((r) => r.sk.S.startsWith('TURN#') && r.role.S === 'user').map((r) => r.content.S)

describe('voice messages', () => {
  let errorLog, warnLog
  beforeEach(() => {
    rows.clear()
    objects.clear()
    jobs.clear()
    startedJobs.length = 0
    chatRequests.length = 0
    lineReplies.length = 0
    loadingCalls.length = 0
    Object.assign(speech, { transcript: '最近工作壓力很大，晚上睡不著', fails: false, neverFinishes: false })
    line.notReadyFor = 0
    llm.summaryFails = false
    hooks.beforeUpdate = () => {}
    Object.assign(account, { optOut: optedOutForAll, error: null, hangs: false })
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {})
    warnLog = jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.useFakeTimers({ now: NOV, advanceTimers: true })
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('answers a voice message as if the user had typed what they said', async () => {
    await sendVoice({ seconds: 12 })

    expect(chatRequests[0].messages.at(-1)).toEqual({ role: 'user', content: '最近工作壓力很大，晚上睡不著' })
    expect(lineReplies).toEqual(['（模型的回覆）'])
    expect(userTurns()).toEqual(['最近工作壓力很大，晚上睡不著'])
    expect(usedSeconds('2026-11')).toBe(12)
    expect(everyoneSeconds('2026-11')).toBe(12)
  })

  it('keeps the typing animation up for the longest LINE allows while it listens', async () => {
    await sendVoice()

    expect(loadingCalls[0]).toEqual({ chatId: USER, loadingSeconds: 60 })
  })

  it('transcribes as Taiwanese Mandarin and leaves neither the recording nor the transcript in S3, nor the job in Transcribe', async () => {
    await sendVoice()

    expect(startedJobs.map((job) => job.LanguageCode)).toEqual(['zh-TW'])
    expect(objects.size).toBe(0)
    expect(jobs.size).toBe(0)
  })

  it('stops at the monthly minutes, without transcribing, and points to the keyboard microphone', async () => {
    setUsed('2026-11', 30 * 60 - 10)

    await sendVoice({ seconds: 10 })
    await sendVoice({ seconds: 1 })

    expect(usedSeconds('2026-11')).toBe(30 * 60)
    expect(everyoneSeconds('2026-11')).toBe(10)
    expect(lineReplies[1]).toContain('超過你這個月剩下的語音額度了（每個月 30 分鐘，下個月 1 號重新計算）')
    expect(lineReplies[1]).toContain('鍵盤上的麥克風')
    expect(chatRequests).toHaveLength(1)
    expect(userTurns()).toEqual(['最近工作壓力很大，晚上睡不著', '（傳了一段語音）'])
  })

  it('turns away a recording over 3 minutes before anything is counted or paid for, and asks for shorter pieces', async () => {
    await sendVoice({ seconds: 3 * 60 + 1 })
    await sendVoice({ seconds: 31 * 60 })

    expect(lineReplies[0]).toContain('我一次最多能聽 3 分鐘')
    expect(lineReplies[0]).toContain('分成短一點的幾段')
    expect(lineReplies[1]).toContain('我一次最多能聽 3 分鐘')
    expect(startedJobs).toHaveLength(0)
    expect(usedSeconds('2026-11')).toBe(0)
    expect(everyoneSeconds('2026-11')).toBe(0)
  })

  it('hears a recording of exactly 3 minutes', async () => {
    await sendVoice({ seconds: 3 * 60 })

    expect(chatRequests).toHaveLength(1)
    expect(usedSeconds('2026-11')).toBe(180)
  })

  it('stops everyone at the monthly total for all users, says when voice comes back, and raises the alarm', async () => {
    setEveryone('2026-11', 1500 * 60 - 10)

    await sendVoice({ seconds: 10, user: 'U-first' })
    await sendVoice({ seconds: 1, user: 'U-second' })

    expect(chatRequests).toHaveLength(1)
    expect(everyoneSeconds('2026-11')).toBe(1500 * 60)
    expect(usedSeconds('2026-11', 'U-second')).toBe(0)
    expect(lineReplies[1]).toContain('這個月大家的語音額度已經用完了，下個月 1 號會恢復')
    expect(lineReplies[1]).toContain('鍵盤上的麥克風')
    expect(startedJobs).toHaveLength(1)
    expect(warnLog.mock.calls.map((call) => call[0])).toContain('Voice limit for all users reached: 1500 minutes in 2026-11')
  })

  it('lets only one of two users take the last of everyone\'s minutes when they send at the same moment', async () => {
    setEveryone('2026-11', 1500 * 60 - 10)

    await Promise.all([sendVoice({ seconds: 10, user: 'U-first' }), sendVoice({ seconds: 10, user: 'U-second' })])

    expect(everyoneSeconds('2026-11')).toBe(1500 * 60)
    expect(usedSeconds('2026-11', 'U-first') + usedSeconds('2026-11', 'U-second')).toBe(10)
    expect(chatRequests).toHaveLength(1)
  })

  it('starts everyone\'s total afresh each Taipei month', async () => {
    setEveryone('2026-11', 1500 * 60)

    jest.setSystemTime(Date.parse('2026-11-30T16:30:00Z'))
    await sendVoice({ seconds: 12 })

    expect(chatRequests).toHaveLength(1)
    expect(everyoneSeconds('2026-12')).toBe(12)
  })

  it('lets only one of two messages that arrive together take the last minutes', async () => {
    setUsed('2026-11', 30 * 60 - 10)

    await Promise.all([sendVoice({ seconds: 10 }), sendVoice({ seconds: 10 })])

    expect(usedSeconds('2026-11')).toBe(30 * 60)
    expect(chatRequests).toHaveLength(1)
  })

  it('starts each month afresh on Taipei time', async () => {
    setUsed('2026-11', 30 * 60)

    // 2026-12-01 00:30 in Taipei, still November in UTC.
    jest.setSystemTime(Date.parse('2026-11-30T16:30:00Z'))
    await sendVoice({ seconds: 12 })

    expect(chatRequests).toHaveLength(1)
    expect(usedSeconds('2026-12')).toBe(12)
  })

  it('gives the user their minutes back but keeps them in everyone\'s count when a transcription fails, apologises, raises the alarm and leaves nothing behind', async () => {
    speech.fails = true

    await sendVoice({ seconds: 12 })

    expect(usedSeconds('2026-11')).toBe(0)
    expect(everyoneSeconds('2026-11')).toBe(12)
    expect(lineReplies[0]).toContain('卡住')
    expect(errorLog.mock.calls[0][0]).toBe('Handler error:')
    expect(objects.size).toBe(0)
    expect(jobs.size).toBe(0)
  })

  it('gives up, gives the minutes back and apologises when the message is too old to answer within the reply token', async () => {
    // LINE sent it 50 seconds ago (a cold start, or earlier events in the same webhook).
    await sendVoice({ seconds: 12, at: Date.now() - 50_000 })

    expect(chatRequests).toHaveLength(0)
    expect(startedJobs).toHaveLength(0)
    expect(usedSeconds('2026-11')).toBe(0)
    expect(everyoneSeconds('2026-11')).toBe(0)
    expect(lineReplies[0]).toContain('卡住')
    expect(objects.size).toBe(0)
  })

  describe('when Amazon may keep what Transcribe hears', () => {
    const paused = async () => {
      await sendVoice({ seconds: 12 })

      expect(startedJobs).toHaveLength(0)
      expect(objects.size).toBe(0)
      expect(usedSeconds('2026-11')).toBe(0)
      expect(lineReplies[0]).toContain('語音這邊暫時沒辦法聽')
      expect(lineReplies[0]).not.toContain('再傳一次')
      expect(userTurns()).toEqual(['（傳了一段語音）'])
      expect(errorLog.mock.calls[0][0]).toMatch(/^Handler error: voice paused/)
    }

    it('pauses voice when the account is in no organization, as during a move between organizations', async () => {
      account.error = 'AWSOrganizationsNotInUseException'
      await paused()
    })

    it('pauses voice when no opt-out policy applies to the account', async () => {
      account.error = 'EffectivePolicyNotFoundException'
      await paused()
    })

    it('pauses voice when the policy opts Transcribe back in, even if everything else is opted out', async () => {
      account.optOut = { services: { default: { opt_out_policy: 'optOut' }, transcribe: { opt_out_policy: 'optIn' } } }
      await paused()
    })

    it('pauses voice when the opt-out cannot be checked', async () => {
      account.error = 'TooManyRequestsException'
      await paused()
    })
  })

  it('hears voice when Transcribe itself is opted out, with no default in the policy', async () => {
    account.optOut = { services: { transcribe: { opt_out_policy: 'optOut' } } }

    await sendVoice()

    expect(chatRequests).toHaveLength(1)
  })

  it('keeps everyone\'s count but gives the user back their minutes when a job outruns the deadline', async () => {
    speech.neverFinishes = true

    const handled = sendVoice({ seconds: 12 })
    while (startedJobs.length === 0) await new Promise((resolve) => setImmediate(resolve))
    jest.setSystemTime(Date.now() + 45_000)
    await handled

    expect(startedJobs).toHaveLength(1)
    expect(usedSeconds('2026-11')).toBe(0)
    expect(everyoneSeconds('2026-11')).toBe(12)
    expect(lineReplies[0]).toContain('卡住')
  })

  it('keeps the minutes counted once the answer has been sent, even if remembering the exchange then fails', async () => {
    putTurns(5)
    llm.summaryFails = true

    await sendVoice({ seconds: 12 })

    expect(lineReplies[0]).toBe('（模型的回覆）')
    expect(usedSeconds('2026-11')).toBe(12)
    expect(everyoneSeconds('2026-11')).toBe(12)
  })

  it('gives the user their seconds back when counting them against everyone fails', async () => {
    hooks.beforeUpdate = (input) => {
      if (input.Key.pk.S === 'ALL_USERS' && input.UpdateExpression.startsWith('SET')) {
        throw Object.assign(new Error('DynamoDB is unavailable'), { name: 'InternalServerError' })
      }
    }

    await sendVoice({ seconds: 12 })

    expect(usedSeconds('2026-11')).toBe(0)
    expect(startedJobs).toHaveLength(0)
    expect(lineReplies[0]).toContain('卡住')
  })

  it('raises the alarm with what to add back, naming the user only by a hash, when a give-back fails', async () => {
    speech.fails = true
    hooks.beforeUpdate = (input) => {
      if (input.UpdateExpression === 'ADD #used :refund') throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' })
    }

    await sendVoice({ seconds: 12 })

    const lines = errorLog.mock.calls.map((call) => String(call[0]))
    expect(lines).toContainEqual(expect.stringMatching(/^Handler error: voice seconds not given back: 12 s for user [0-9a-f]{12} in 2026-11 \(ThrottlingException\)$/))
    expect(lines.join('\n')).not.toContain(USER)
  })

  it('pauses voice within a few seconds when the opt-out check does not answer', async () => {
    account.hangs = true
    const startedAt = performance.now()

    await sendVoice({ seconds: 12 })

    expect(performance.now() - startedAt).toBeLessThan(4_500)
    expect(startedJobs).toHaveLength(0)
    expect(lineReplies[0]).toContain('語音這邊暫時沒辦法聽')
    expect(usedSeconds('2026-11')).toBe(0)
  }, 10_000)

  it('says it heard nothing when the recording has no speech, without asking the model', async () => {
    speech.transcript = '  '

    await sendVoice()

    expect(chatRequests).toHaveLength(0)
    expect(lineReplies[0]).toContain('沒聽到說話的聲音')
    expect(userTurns()).toEqual(['（傳了一段語音）'])
  })

  it('waits while LINE is still preparing a large recording', async () => {
    line.notReadyFor = 2

    await sendVoice()

    expect(lineReplies).toEqual(['（模型的回覆）'])
  })
})

describe('transcribe', () => {
  beforeEach(() => {
    objects.clear()
    jobs.clear()
    Object.assign(speech, { transcript: '你好', fails: false, neverFinishes: false })
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())

  it('starts no job and uploads nothing when too little time is left for one', async () => {
    await expect(transcribe(Buffer.from('m4a'), { deadline: Date.now() + 5_000 })).rejects.toThrow('Too little time')

    expect(objects.size).toBe(0)
    expect(jobs.size).toBe(0)
  })

  it('gives up at the deadline and still deletes the recording, though the running job cannot be deleted', async () => {
    speech.neverFinishes = true
    jest.useFakeTimers({ advanceTimers: true })
    let jobAskedFor = false

    const done = transcribe(Buffer.from('m4a'), { deadline: Date.now() + 20_000, pollMs: 10, onJobStart: () => (jobAskedFor = true) })
    while (jobs.size === 0) await new Promise((resolve) => setImmediate(resolve))
    jest.setSystemTime(Date.now() + 25_000)

    await expect(done).rejects.toThrow('deadline')
    jest.useRealTimers()
    expect(jobAskedFor).toBe(true)
    expect(objects.size).toBe(0)
    expect([...jobs.values()].map((job) => job.status)).toEqual(['IN_PROGRESS'])
  })
})
