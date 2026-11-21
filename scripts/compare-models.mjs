// Replays the held-out conversations against Claude chat models and prompt
// versions through the production AnthropicProvider, and writes every reply
// with its latency and cost to a JSON file for side-by-side reading.
//
// Run:  node scripts/compare-models.mjs <out.json> [--replays N] <arm>...
//       <arm> is a key of ARMS below, optionally with a prompt module to use
//       instead of lambda/prompt.mjs: haiku-4-5=/path/to/prompt.mjs
//       --replays N plays every conversation N times per arm (default 1),
//       since one sample per turn is too noisy to compare prompts.
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { AnthropicProvider } from '../lambda/providers/anthropic.mjs'
import { conversations } from './held-out-conversations.mjs'

const MAX_RECENT_TURNS = Number(process.env.MAX_RECENT_TURNS || 5)
const LAMBDA_TIMEOUT_MS = 30_000
const PRODUCTION_PROMPT = new URL('../lambda/prompt.mjs', import.meta.url).pathname

// USD per million tokens, Anthropic list prices as of 2026-11.
const HAIKU_4_5 = { model: 'claude-haiku-4-5-20251001', price: { in: 1, out: 5 } }
const HAIKU_5_5 = { model: 'claude-haiku-5-5', price: { in: 0.1, out: 0.5 } }
const ARMS = {
  'haiku-4-5': { ...HAIKU_4_5, effort: null },
  'haiku-5-5-medium': { ...HAIKU_5_5, effort: 'medium' },
  'haiku-5-5-xhigh': { ...HAIKU_5_5, effort: 'xhigh' },
  'haiku-5-5-max': { ...HAIKU_5_5, effort: 'max' },
  'sonnet-5-5-high': { model: 'claude-sonnet-5-5', effort: 'high', price: { in: 2, out: 10 } },
  'opus-5-5-high': { model: 'claude-opus-5-5', effort: 'high', price: { in: 4, out: 20 } },
}

const args = process.argv.slice(2)
const replaysAt = args.indexOf('--replays')
const replays = replaysAt === -1 ? 1 : Number(args.splice(replaysAt, 2)[1])
const [outPath, ...armSpecs] = args
const parsed = armSpecs.map((spec) => {
  const [modelId, promptPath] = spec.split('=')
  return { spec, modelId, prompt: promptPath ? resolve(promptPath) : PRODUCTION_PROMPT }
})
const unknown = parsed.filter((a) => !ARMS[a.modelId]).map((a) => a.modelId)
if (!outPath || parsed.length === 0 || unknown.length || !(replays >= 1)) {
  throw new Error(
    `usage: node scripts/compare-models.mjs <out.json> [--replays N] <arm>[=<prompt.mjs>]... (known arms: ${Object.keys(ARMS).join(', ')})`
  )
}

// Replays run concurrently, so each one keeps the usage of its own last request.
const replayCall = new AsyncLocalStorage()
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const res = await realFetch(url, init)
  const call = replayCall.getStore()
  if (call && String(url).startsWith('https://api.anthropic.com/')) {
    call.usage = (await res.clone().json().catch(() => ({}))).usage ?? null
  }
  return res
}

function providerFor(arm) {
  process.env.CHAT_MODEL_ANTHROPIC = arm.model
  if (arm.effort) process.env.CHAT_EFFORT_ANTHROPIC = arm.effort
  else delete process.env.CHAT_EFFORT_ANTHROPIC
  return new AnthropicProvider()
}

async function playConversations(arm, provider, buildMessages) {
  const call = replayCall.getStore()
  const results = []
  for (const convo of conversations) {
    const recentTurns = []
    const turns = []
    for (const userText of convo.turns) {
      const messages = buildMessages({
        summary: null,
        recentTurns: recentTurns.slice(-2 * MAX_RECENT_TURNS),
        userInput: userText,
      })
      call.usage = null
      const startedAt = Date.now()
      try {
        const { text } = await provider.chatCompletion(messages)
        const ms = Date.now() - startedAt
        const inputTokens = call.usage?.input_tokens ?? 0
        const outputTokens = call.usage?.output_tokens ?? 0
        turns.push({
          user: userText,
          text,
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
  return results
}

const arms = await Promise.all(
  parsed.map(async ({ spec, modelId, prompt }) => {
    const arm = { id: spec, ...ARMS[modelId], prompt }
    const provider = providerFor(arm)
    const { buildMessages } = await import(pathToFileURL(prompt).href)
    const runs = await Promise.all(
      Array.from({ length: replays }, () => replayCall.run({}, () => playConversations(arm, provider, buildMessages)))
    )
    return { ...arm, conversations: runs[0], runs }
  })
)
writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), replays, arms }, null, 2))
console.error(`wrote ${outPath}`)
