import { createHmac } from 'node:crypto'
import { AnthropicProvider, BedrockBackup } from './providers/anthropic.mjs'
import { verifySignature } from './line.mjs'

// Proves a deploy can still answer: one short question to Anthropic, one to
// the model for worries when there is one, one to the backup, and a LINE
// signature made and checked with the real secret. Traffic
// is too thin for errors to show this within minutes. The results are the
// bot's own failure messages (status and error type), nothing anyone said.
const QUESTION = [{ role: 'user', content: '請只回一個字：好' }]
// Anthropic is asked the way real messages are, with a system text marked as
// the same for everyone, so a deploy also proves that form is taken.
const AS_REAL_MESSAGES_ARE = [{ role: 'system', content: '這是部署後的自我檢查。', sameForEveryone: true }, ...QUESTION]
const ANSWER_WITHIN_MS = 15_000

export async function selfTest({
  anthropic = new AnthropicProvider({ backup: null }),
  backup = process.env.BEDROCK_MODEL_ID ? new BedrockBackup(process.env.BEDROCK_MODEL_ID) : null,
  secret = process.env.LINE_CHANNEL_SECRET,
} = {}) {
  const results = {
    anthropic: await outcome(() => anthropic.chatCompletion(AS_REAL_MESSAGES_ARE, { signal: AbortSignal.timeout(ANSWER_WITHIN_MS) })),
    // Worries reach their model when the talk can be sorted, which is a short
    // question, and when that model answers. Either one failing would turn
    // every worry into the chat model's answer, unnoticed, so a deploy does
    // not pass with it.
    worries: anthropic.answersWorries
      ? await outcome(async () => {
          await anthropic.ask('請只回一個字母：A', { signal: AbortSignal.timeout(ANSWER_WITHIN_MS) })
          await anthropic.chatCompletion(AS_REAL_MESSAGES_ARE, { worries: true, signal: AbortSignal.timeout(ANSWER_WITHIN_MS) })
        })
      : 'off',
    bedrock: backup
      ? await outcome(() => backup.send('chat', { max_tokens: 16, messages: QUESTION }, AbortSignal.timeout(ANSWER_WITHIN_MS)))
      : 'off',
    signature: signatureRoundTrip(secret),
  }
  return { statusCode: 200, body: JSON.stringify(results) }
}

async function outcome(call) {
  try {
    await call()
    return 'ok'
  } catch (err) {
    return err.message
  }
}

function signatureRoundTrip(secret) {
  if (!secret) return 'no secret'
  const body = JSON.stringify({ destination: 'self-test', events: [] })
  const signature = createHmac('SHA256', secret).update(body).digest('base64')
  return verifySignature(body, signature, secret) && !verifySignature(body, 'forged', secret) ? 'ok' : 'failed'
}
