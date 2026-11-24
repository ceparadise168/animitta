import { createHmac } from 'node:crypto'
import { AnthropicProvider, BedrockBackup } from './providers/anthropic.mjs'
import { verifySignature } from './line.mjs'

// Proves a deploy can still answer: one short question to Anthropic, one to the
// backup, and a LINE signature made and checked with the real secret. Traffic
// is too thin for errors to show this within minutes. The results are the
// bot's own failure messages (status and error type), nothing anyone said.
const QUESTION = [{ role: 'user', content: '請只回一個字：好' }]
const ANSWER_WITHIN_MS = 15_000

export async function selfTest({
  anthropic = new AnthropicProvider({ backup: null }),
  backup = process.env.BEDROCK_MODEL_ID ? new BedrockBackup(process.env.BEDROCK_MODEL_ID) : null,
  secret = process.env.LINE_CHANNEL_SECRET,
} = {}) {
  const results = {
    anthropic: await outcome(() => anthropic.chatCompletion(QUESTION, { signal: AbortSignal.timeout(ANSWER_WITHIN_MS) })),
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
