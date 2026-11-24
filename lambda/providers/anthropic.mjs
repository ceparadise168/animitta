import { LlmProvider } from './base.mjs'

// The error types Anthropic documents. Only these reach the log; the API's
// own message stays out, so the alert email can trust what it reads.
const ERROR_TYPES = new Set([
  'invalid_request_error',
  'authentication_error',
  'billing_error',
  'permission_error',
  'not_found_error',
  'conflict_error',
  'request_too_large',
  'rate_limit_error',
  'api_error',
  'timeout_error',
  'overloaded_error',
])
// Failures that tend to pass within a second or two, worth one more try when
// they came back fast. A slow failure goes to the backup instead.
const TEMPORARY_STATUSES = new Set([500, 502, 503, 504, 529])
// Codes Anthropic documents in error.details.error_code for a 429.
const ERROR_CODES = new Set(['enforced_spend_limit_reached', 'ramp_limit_exceeded'])
// A 429 is usually a rate limit: someone may be flooding the bot, and the
// backup has no limit of its own, so it gets the apology instead. The monthly
// spend cap is a 429 too, but it lasts until next month, so that one moves on.
const SPEND_CAP = 'enforced_spend_limit_reached'
// Up to two summaries are written after the reply, which itself may take 55
// seconds, and all of it has to end within the function's 90 seconds. One try
// at Anthropic gets about half, so a hung Anthropic leaves the backup time.
const SUMMARY_BUDGET_MS = 15_000

export class AnthropicProvider extends LlmProvider {
  #apiKey
  #chatModel
  #chatEffort
  #summaryModel
  #backup
  #retryPauseMs
  #chatAttemptMs
  #fastFailureMs
  #summaryAttemptMs

  // chatAttemptMs: the most one try at Anthropic may take before the backup
  // gets its turn, so a hung Anthropic does not use up the whole deadline.
  // fastFailureMs: a failure quicker than this may be retried; a slower one
  // goes to the backup.
  constructor({ backup = bedrockFromEnv(), retryPauseMs = 1000, chatAttemptMs = 20_000, summaryAttemptMs = 7_000, fastFailureMs = 5_000 } = {}) {
    super()
    this.#backup = backup
    this.#retryPauseMs = retryPauseMs
    this.#chatAttemptMs = chatAttemptMs
    this.#fastFailureMs = fastFailureMs
    this.#summaryAttemptMs = summaryAttemptMs
    this.#apiKey = process.env.ANTHROPIC_API_KEY
    this.#chatModel =
      process.env.CHAT_MODEL_ANTHROPIC || 'claude-haiku-4-5-20251001'
    this.#chatEffort = process.env.CHAT_EFFORT_ANTHROPIC || null
    this.#summaryModel =
      process.env.SUMMARY_MODEL_ANTHROPIC || 'claude-haiku-4-5-20251001'
  }

  // deadline: when the caller's signal fires (ms since epoch). With little
  // time left, as after a long voice transcription, one try gets only half of
  // it, so the backup still has the other half.
  async chatCompletion(messages, { signal, deadline } = {}) {
    const { system, userMessages } = this.#extractSystem(messages)
    const body = { ...this.#chatTuning(), ...(system && { system }), messages: userMessages }
    const attemptMs = () => (deadline ? Math.min(this.#chatAttemptMs, Math.max(1_000, (deadline - Date.now()) / 2)) : this.#chatAttemptMs)
    const data = await this.#send('chat', this.#chatModel, body, signal, attemptMs)
    return { text: readReplyText(data) }
  }

  // Anthropic first, once more if the failure looks temporary, then the
  // backup: the same model on Amazon Bedrock, given the same request. The
  // signal is the caller's deadline; once it fires nothing more is tried.
  async #send(op, model, body, signal, attemptMs) {
    let failure
    for (let attempt = 1; attempt <= 2; attempt++) {
      const attemptSignal = withTimeout(signal, attemptMs())
      const startedAt = Date.now()
      try {
        return await askAnthropic(op, this.#apiKey, model, body, attemptSignal)
      } catch (err) {
        const gaveUp = attemptSignal?.aborted && !signal?.aborted
        failure = gaveUp ? Object.assign(new Error(`Anthropic ${op} failed: no response`), { cause: err }) : err
      }
      const fast = Date.now() - startedAt < this.#fastFailureMs
      if (signal?.aborted || attempt === 2 || !fast || !isTemporary(failure)) break
      await pause(this.#retryPauseMs, signal)
      if (signal?.aborted) break
    }
    const rateLimited = failure.status === 429 && failure.code !== SPEND_CAP
    if (!this.#backup || signal?.aborted || rateLimited) throw failure
    try {
      const data = await this.#backup.send(op, body, signal)
      // Counted by an alarm: people still get answers, but Anthropic is down.
      console.warn(`Provider fallback: ${failure.message} -> Bedrock ${op} ok`)
      return data
    } catch (backupFailure) {
      throw Object.assign(new Error(`${failure.message}; backup: ${backupFailure.message}`, { cause: failure }), {
        status: failure.status,
      })
    }
  }

  // Claude 4.6+ models reject temperature and think before answering; they are
  // tuned with effort instead, and need max_tokens room for the thinking.
  #chatTuning() {
    return this.#chatEffort
      ? { max_tokens: 16000, output_config: { effort: this.#chatEffort } }
      : { max_tokens: 1024, temperature: 0.8 }
  }

  async summarize(existingSummary, turns, { signal = AbortSignal.timeout(SUMMARY_BUDGET_MS) } = {}) {
    const turnsText = turns
      .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n')

    const prompt =
      '以中性、第三人稱、紀錄員視角，將以下對話歷史濃縮為不超過 500 字的繁體中文摘要。\n' +
      '\n' +
      '保留：\n' +
      '- 使用者主動提到的關鍵事實（家庭/工作/健康/興趣等具體資訊）\n' +
      '- 使用者表達過的核心煩惱或問題主題\n' +
      '- 使用者明確表達過的情緒狀態（若有）\n' +
      '- 重要的對話節點（user 問過什麼大問題、bot 給過什麼方向）\n' +
      '\n' +
      '不要：\n' +
      '- 不要用「諮商師」「治療師」「導師」「mentor」「老師」等角色詞描述 bot 一方、用「無相界」或「bot」\n' +
      '- 不要模仿無相界的語氣風格（不用 image-first、不用 LINE particle）\n' +
      '- 不要評價對話品質、不要下任何建議、不要寫「應該」「建議」\n' +
      '- 不要腦補使用者沒講過的家庭/婚姻/健康/伴侶/小孩等狀況\n' +
      '\n' +
      '**重要**：這份摘要是給未來對話的 bot 當 reference 用、是 context info、不是 voice template。bot 讀完不應該模仿摘要的語氣。\n' +
      '\n' +
      (existingSummary ? `舊摘要：\n${existingSummary}\n\n` : '') +
      `需要壓縮的對話：\n${turnsText}`

    const body = { max_tokens: 1024, temperature: 0.3, messages: [{ role: 'user', content: prompt }] }
    const data = await this.#send('summary', this.#summaryModel, body, signal, () => this.#summaryAttemptMs)
    return data.content[0].text
  }

  #extractSystem(messages) {
    let systemParts = []
    let nonSystem = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemParts.push(msg.content)
      } else {
        nonSystem.push(msg)
      }
    }

    // Merge consecutive same-role messages
    const merged = []
    for (const msg of nonSystem) {
      const last = merged[merged.length - 1]
      if (last && last.role === msg.role) {
        last.content += '\n\n' + msg.content
      } else {
        merged.push({ ...msg })
      }
    }

    return {
      system: systemParts.length > 0 ? systemParts.join('\n\n') : null,
      userMessages: merged,
    }
  }
}

async function askAnthropic(op, apiKey, model, body, signal) {
  let res
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, ...body }),
    })
  } catch (err) {
    if (signal?.aborted) throw err
    // fetch's own message can quote a header, and so the key: never pass it on.
    throw Object.assign(new Error(`Anthropic ${op} failed: no response`), { network: true })
  }
  if (!res.ok) throw await anthropicFailure(op, res)
  try {
    return await res.json()
  } catch {
    throw new Error(`Anthropic ${op} failed: unreadable reply`)
  }
}

async function anthropicFailure(op, res) {
  let error
  try {
    error = (await res.json())?.error
  } catch {
    // A proxy's HTML error page, say: the status alone still names it.
  }
  // A limit Eric set himself in the Console has no code, only this documented
  // start of the message; it is named, never quoted.
  const ownLimit = res.status === 400 && String(error?.message ?? '').startsWith('You have reached your specified API usage limits')
  const code = ownLimit ? 'specified_limit_reached' : ERROR_CODES.has(error?.details?.error_code) ? error.details.error_code : undefined
  const type = ERROR_TYPES.has(error?.type) ? error.type : undefined
  const named = code ?? type
  return Object.assign(new Error(`Anthropic ${op} failed: ${res.status}${named ? ` ${named}` : ''}`), { status: res.status, code })
}

function withTimeout(signal, ms) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

function isTemporary(err) {
  return TEMPORARY_STATUSES.has(err.status) || err.network === true
}

function pause(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function bedrockFromEnv() {
  return process.env.BEDROCK_MODEL_ID ? new BedrockBackup(process.env.BEDROCK_MODEL_ID) : null
}

// The same Claude model, run by Amazon Bedrock in Japan's regions and billed to
// the AWS account, so it still answers when the Anthropic account cannot.
export class BedrockBackup {
  #modelId
  #client

  constructor(modelId, client = null) {
    this.#modelId = modelId
    this.#client = client
  }

  async send(op, body, signal) {
    let res
    try {
      // Loaded on first use, so if the runtime ever lacked this module only
      // the backup would fail, never every message and its apology.
      const sdk = await import('@aws-sdk/client-bedrock-runtime').catch(() => null)
      if (!sdk) throw Object.assign(new Error('no SDK'), { name: 'SdkMissing' })
      const { BedrockRuntimeClient, InvokeModelCommand } = sdk
      this.#client ??= new BedrockRuntimeClient({})
      res = await this.#client.send(
        new InvokeModelCommand({
          modelId: this.#modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', ...body }),
        }),
        { abortSignal: signal }
      )
    } catch (err) {
      if (signal?.aborted) throw err
      const name = /^[A-Za-z]{3,60}$/.test(err.name ?? '') ? ` ${err.name}` : ''
      const status = err.$metadata?.httpStatusCode
      throw Object.assign(new Error(`Bedrock ${op} failed: ${status ?? 'no response'}${name}`), { status })
    }
    try {
      return JSON.parse(new TextDecoder().decode(res.body))
    } catch {
      throw new Error(`Bedrock ${op} failed: unreadable reply`)
    }
  }
}

function readReplyText(data) {
  if (data.stop_reason === 'refusal') {
    throw new Error(`Anthropic chat refused: ${data.stop_details?.category ?? 'unknown'}`)
  }
  const text = data.content.find((block) => block.type === 'text')?.text
  if (!text) throw new Error(`Anthropic chat returned no text (stop_reason: ${data.stop_reason})`)
  return text
}
