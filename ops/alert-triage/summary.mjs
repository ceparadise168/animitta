// Turns the bot's failure lines into a summary built only from values this
// file lists: status codes, documented error types, known error classes, and
// file:line of the bot's own code. Nothing else in a line is kept, so what
// someone typed, or text written to steer Claude, never leaves the log.

// Anthropic's documented error types and codes, and Bedrock's exception names.
const TYPES = new Set([
  'invalid_request_error', 'authentication_error', 'billing_error', 'permission_error', 'not_found_error',
  'conflict_error', 'request_too_large', 'rate_limit_error', 'api_error', 'timeout_error', 'overloaded_error',
  'enforced_spend_limit_reached', 'ramp_limit_exceeded',
  'AccessDeniedException', 'ThrottlingException', 'ValidationException', 'ServiceUnavailableException',
  'ModelNotReadyException', 'ModelTimeoutException', 'ModelErrorException', 'InternalServerException',
  'ResourceNotFoundException', 'ServiceQuotaExceededException', 'SdkMissing', 'specified_limit_reached',
])
const ERROR_CLASSES = new Set([
  'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'AggregateError',
  'ImportModuleError', 'UserCodeSyntaxError', 'ValidationException', 'ConditionalCheckFailedException',
  'ResourceNotFoundException', 'ProvisionedThroughputExceededException', 'ThrottlingException',
  'TransactionCanceledException', 'AccessDeniedException', 'InternalServerError',
])
const listed = (set, value) => (set.has(value) ? value : null)
// The bot's own files (lambda/), so a made-up path in an error never passes.
// A test keeps this list equal to what is in lambda/.
export const BOT_FILES = new Set([
  'commands.mjs', 'crisis.mjs', 'index.mjs', 'line.mjs', 'prompt.mjs', 'self-test.mjs', 'sutra.mjs',
  'providers/anthropic.mjs', 'providers/base.mjs', 'providers/index.mjs', 'providers/openai.mjs',
  'services/ai-opt-out.mjs', 'services/chat.mjs', 'services/memory.mjs', 'services/transcribe.mjs', 'services/voice.mjs',
])

const PROVIDER = /(Anthropic|OpenAI|Bedrock) (chat|summary) failed: (\d{3}|no response|unreadable reply)(?: ([A-Za-z_]{3,60}))?/
const ABORTED = /aborted due to timeout|\b(TimeoutError|AbortError)\b/
const LINE_CALL = /LINE (link rich menu|loading indicator|content download|reply|quick reply) failed: (\d{3})/
const REFUSED = /Anthropic chat (refused|returned no text)|carried the model's notes to itself/
const LAMBDA_TIMEOUT = /Task timed out after [\d.]{1,8} seconds/
const RUNTIME_EXIT = /Runtime exited/
const DEADLINE = /\b(TimeoutError|AbortError)\b/
const VOICE_PAUSED = /voice paused, the recording was not sent to Amazon/
const VOICE_REFUND = /voice seconds not given back/
const TRANSCRIBE = /Transcription (failed|was not done by the deadline)/
const ERROR_CLASS = /\b([A-Z][A-Za-z]{2,40}(?:Error|Exception))\b/
const FRAME = /\/var\/task\/([\w/.-]{1,60}\.mjs):(\d{1,5})/g

// One cause per line, the most specific first.
export function causeOf(line) {
  // "<Anthropic's failure>; backup: <Bedrock's failure>" when both failed.
  const [primaryPart, backupPart = ''] = line.split('; backup: ')
  const primary = primaryPart.match(PROVIDER)
  const backup = backupPart.match(PROVIDER)
  if (primary || backup) {
    return {
      kind: 'provider',
      service: primary?.[1] ?? 'Anthropic',
      op: (primary ?? backup)[2],
      status: primary?.[3] ?? (ABORTED.test(primaryPart) ? 'timeout' : 'unknown'),
      type: listed(TYPES, primary?.[4]),
      backup: backup ? [backup[3], listed(TYPES, backup[4])].filter(Boolean).join(' ') : null,
    }
  }
  const line_ = line.match(LINE_CALL)
  if (line_) return { kind: 'line', call: line_[1], status: line_[2] }
  if (REFUSED.test(line)) return { kind: 'refused' }
  if (LAMBDA_TIMEOUT.test(line)) return { kind: 'lambda-timeout' }
  if (RUNTIME_EXIT.test(line)) return { kind: 'runtime-exit' }
  if (VOICE_PAUSED.test(line)) return { kind: 'voice-paused' }
  if (VOICE_REFUND.test(line)) return { kind: 'voice-refund' }
  if (TRANSCRIBE.test(line)) return { kind: 'transcribe' }
  if (DEADLINE.test(line)) return { kind: 'deadline' }
  const found = line.match(ERROR_CLASS)?.[1]
  const errorClass = found ? (listed(ERROR_CLASSES, found) ?? 'OtherError') : null
  const frames = [...new Set([...line.matchAll(FRAME)].filter(([, file]) => BOT_FILES.has(file)).map(([, file, at]) => `${file}:${at}`))].slice(0, 3)
  if (errorClass || frames.length) return { kind: 'code', errorClass: errorClass ?? null, frames }
  return { kind: 'unknown' }
}

export const signatureOf = (cause) =>
  [cause.kind, cause.service, cause.op, cause.status, cause.type, cause.call, cause.errorClass, cause.frames?.[0]]
    .filter(Boolean)
    .join(':')

// events: [{ timestamp, message }] from CloudWatch Logs.
export function summarize(events) {
  const causes = new Map()
  for (const { timestamp, message } of events) {
    const cause = causeOf(message)
    const key = signatureOf(cause)
    const seen = causes.get(key)
    if (seen) {
      seen.count++
      seen.first = Math.min(seen.first, timestamp)
      seen.last = Math.max(seen.last, timestamp)
    } else {
      causes.set(key, { ...cause, signature: key, count: 1, first: timestamp, last: timestamp })
    }
  }
  return [...causes.values()].sort((a, b) => b.count - a.count)
}

// Causes that may need a code change. The rest are for a person outside the
// code, or pass by themselves, and would only use up Claude's quiet hours.
const CODE_SHAPED = new Set(['code', 'lambda-timeout', 'runtime-exit', 'unknown'])
export const needsClaude = (causes) => causes.some((cause) => CODE_SHAPED.has(cause.kind))
export const forClaude = (cause) => CODE_SHAPED.has(cause.kind)

// What happened, what people saw, and the one step for Eric. phone: the step
// can be done from a phone; otherwise it needs his computer.
export function explain(cause) {
  switch (cause.kind) {
    case 'provider':
      return explainProvider(cause)
    case 'line':
      return ['401', '403'].includes(cause.status)
        ? step(`LINE 拒絕了呼叫（${cause.call}，${cause.status}），多半是 Channel access token 失效。`, '使用者沒收到回覆。', '到 LINE Developers 換一把 token，改 .env 後部署。', false)
        : step(`LINE 的呼叫失敗（${cause.call}，${cause.status}）。`, '使用者可能沒收到回覆。', '多半是 LINE 那邊的問題，先等等看；一直出現再查。', true)
    case 'refused':
      return step('Claude 拒絕回答、沒有產生文字，或兩次都把寫給自己的筆記混進回覆。', '使用者收到道歉。', '偶發可以不用管；一直出現，再請 Claude 看 prompt。', true)
    case 'deadline':
      return step('AI 在 55 秒內沒答完。', '使用者收到道歉。', '多半是 AI 服務很慢，先等等看。', true)
    case 'lambda-timeout':
      return step('函式跑超過 90 秒被停掉。', '使用者沒收到任何回覆。', 'Claude 正在查是哪一段太慢。', true)
    case 'runtime-exit':
      return step('函式的執行環境整個掛掉了（例如記憶體不夠，或程式一載入就出錯）。', '使用者沒收到任何回覆。', 'Claude 正在查。', true)
    case 'voice-paused':
      return step('語音暫停了：AWS 帳號「AI 服務不拿資料改進服務」的設定沒有生效。', '傳語音的人收到請改用打字的回覆。', '到 AWS Organizations 檢查 AI 服務退出政策。', false)
    case 'voice-refund':
      return step('語音分鐘數沒退回成功（資料庫錯誤）。', '那個人這個月的語音額度可能少算了幾秒。', '偶發可以不用管。', true)
    case 'transcribe':
      return step('語音轉文字失敗或太慢。', '傳語音的人收到道歉。', '偶發可以不用管；一直出現的話，請 Claude 查。', true)
    case 'code':
      return step(`看起來是程式錯誤（${[cause.errorClass, ...cause.frames].filter(Boolean).join('，')}）。`, '使用者收到道歉。', 'Claude 正在查，需要改程式會開 PR 給你。', true)
    default:
      return step('對照表認不出這個錯誤。', '使用者可能收到道歉。', 'Claude 正在查。', true)
  }
}

function explainProvider(cause) {
  const explained = explainPrimary(cause)
  if (!cause.backup?.includes('AccessDenied')) return explained
  return {
    ...explained,
    action: `${explained.action}另外，Bedrock 備援沒開通或權限不足：到 Bedrock 主控台確認 Claude Haiku 4.5 已開通。`,
    phone: false,
  }
}

const OPS = {
  chat: { during: '', slow: '超過 20 秒沒回', seen: '使用者收到道歉。' },
  summary: { during: '整理記憶時', slow: '整理記憶時太久沒回', seen: '使用者有收到回覆，只是記憶整理沒做完，之後的訊息會再試。' },
}

function explainPrimary({ service, op, status, type, backup }) {
  const { during, slow, seen } = OPS[op]
  const alsoBackup = backup ? `，Bedrock 備援也失敗（${backup}）` : ''
  if (status === 'timeout') return step(`${service} ${slow}${alsoBackup}。`, seen, '多半是服務很慢，通常會自己恢復。', true)
  const failed = `${service} ${during}失敗（${[status, type].filter(Boolean).join(' ')}）${alsoBackup}`
  if (status === '401' || type === 'authentication_error') {
    const where = service === 'Anthropic' ? 'platform.claude.com' : '服務的主控台'
    return step(`${failed}：金鑰失效或被撤銷。`, seen, `到 ${where} 產生新金鑰，改 .env 後部署（你手動）。`, false)
  }
  if (type === 'specified_limit_reached') {
    return step(`${failed}：你在 Anthropic 自己設的用量上限到了。`, seen, '到 platform.claude.com 的 Limits 頁調高上限，或等它重新計算。', true)
  }
  if (type === 'enforced_spend_limit_reached') {
    return step(`${failed}：本月的用量上限到了，要等到下個月才會恢復。`, seen, '到 platform.claude.com 的 Limits 頁看上限，需要的話申請提高用量等級。', true)
  }
  if (type === 'billing_error' || (status === '400' && type === 'invalid_request_error')) {
    return step(`${failed}：多半是儲值用完。`, seen, '到 platform.claude.com/settings/billing 看餘額、加值。', true)
  }
  if (status === '429') return step(`${failed}：超過用量上限。`, seen, '通常幾分鐘內恢復；一直出現就到主控台看用量上限。', true)
  if (status === 'no response' || Number(status) >= 500) {
    return step(`${failed}：服務暫時塞車或故障。`, seen, '通常會自己恢復；可以看 status.anthropic.com。', true)
  }
  return step(`${failed}。`, seen, '到 CloudWatch Logs /aws/lambda/animitta 看那一行；看不懂再請 Claude 查。', false)
}

const step = (what, users, action, phone) => ({ what, users, action, phone })
