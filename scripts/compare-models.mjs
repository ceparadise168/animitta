// Replays the held-out conversations against several Claude chat models through
// the production AnthropicProvider and prompt, and writes every reply with its
// latency and cost to a JSON file for side-by-side reading.
//
// Run:  node scripts/compare-models.mjs <out.json>
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { buildMessages } from '../lambda/prompt.mjs'
import { AnthropicProvider } from '../lambda/providers/anthropic.mjs'
import { conversations } from './held-out-conversations.mjs'

const MAX_RECENT_TURNS = Number(process.env.MAX_RECENT_TURNS || 5)
const LAMBDA_TIMEOUT_MS = 30_000

// USD per million tokens, Anthropic list prices as of 2026-11.
const ARMS = [
  { id: 'haiku-4-5', model: 'claude-haiku-4-5-20251001', effort: null, price: { in: 1, out: 5 } },
  { id: 'sonnet-5-5-high', model: 'claude-sonnet-5-5', effort: 'high', price: { in: 2, out: 10 } },
  { id: 'opus-5-5-high', model: 'claude-opus-5-5', effort: 'high', price: { in: 4, out: 20 } },
]

const outPath = process.argv[2]
if (!outPath) throw new Error('usage: node scripts/compare-models.mjs <out.json>')

let lastUsage = null
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const res = await realFetch(url, init)
  if (String(url).startsWith('https://api.anthropic.com/')) {
    lastUsage = (await res.clone().json().catch(() => ({}))).usage ?? null
  }
  return res
}

function providerFor(arm) {
  process.env.CHAT_MODEL_ANTHROPIC = arm.model
  if (arm.effort) process.env.CHAT_EFFORT_ANTHROPIC = arm.effort
  else delete process.env.CHAT_EFFORT_ANTHROPIC
  return new AnthropicProvider()
}

async function runArm(arm) {
  const provider = providerFor(arm)
  const results = []
  for (const convo of conversations) {
    const recentTurns = []
    const turns = []
    for (const userText of convo.turns) {
      const messages = buildMessages({
        summary: null,
        recentTurns: recentTurns.slice(-2 * MAX_RECENT_TURNS),
        userInput: userText,
        isStaleSession: false,
      })
      lastUsage = null
      const startedAt = Date.now()
      try {
        const { text, suggestions } = await provider.chatCompletion(messages)
        const ms = Date.now() - startedAt
        const inputTokens = lastUsage?.input_tokens ?? 0
        const outputTokens = lastUsage?.output_tokens ?? 0
        turns.push({
          user: userText,
          text,
          suggestions,
          chars: [...text.replace(/\s/g, '')].length,
          ms,
          overLambdaTimeout: ms > LAMBDA_TIMEOUT_MS,
          inputTokens,
          outputTokens,
          costUsd: (inputTokens * arm.price.in + outputTokens * arm.price.out) / 1e6,
        })
        recentTurns.push({ role: 'user', content: userText }, { role: 'assistant', content: text })
      } catch (err) {
        turns.push({ user: userText, error: err.message, ms: Date.now() - startedAt })
        break
      }
      console.error(`${arm.id} | ${convo.name} | turn ${turns.length}/${convo.turns.length}`)
    }
    results.push({ name: convo.name, probe: convo.probe, turns })
  }
  return { ...arm, conversations: results }
}

const arms = []
for (const arm of ARMS) arms.push(await runArm(arm))
writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), arms }, null, 2))
console.error(`wrote ${outPath}`)
