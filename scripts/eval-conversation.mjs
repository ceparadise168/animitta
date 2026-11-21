// One-off eval: replay held-out multi-turn conversations against prompt-v3.1.
// The conversations are NOT demo inputs — this tests whether the bot generalises
// the varied-move behaviour, not whether it can parrot a few-shot example.
// Bypasses the DynamoDB memory layer; calls buildMessages + provider directly.
//
// Run:  node scripts/eval-conversation.mjs
//       (uses .env LLM_PROVIDER; prod is openai / gpt-5.4-mini)
import 'dotenv/config'
import { buildMessages } from '../lambda/prompt.mjs'
import { getProvider } from '../lambda/providers/index.mjs'
import { conversations } from './held-out-conversations.mjs'

const MAX_RECENT_TURNS = Number(process.env.MAX_RECENT_TURNS || 5)

function charCount(s) {
  return [...s.replace(/\s/g, '')].length
}

async function run() {
  const provider = getProvider()
  console.log(`provider: ${process.env.LLM_PROVIDER || 'openai'}`)
  console.log('='.repeat(70))

  for (const convo of conversations) {
    console.log(`\n\n### ${convo.name}`)
    console.log(`探針：${convo.probe}\n`)
    const recentTurns = []
    for (const userText of convo.turns) {
      const messages = buildMessages({
        summary: null,
        recentTurns: recentTurns.slice(-2 * MAX_RECENT_TURNS),
        userInput: userText,
        isStaleSession: false,
      })
      let text
      try {
        ;({ text } = await provider.chatCompletion(messages))
      } catch (err) {
        console.log(`使用者：${userText}`)
        console.log(`[ERROR] ${err.message}\n`)
        break
      }
      const tic = text.includes('拆') ? ' ⚠拆' : ''
      console.log(`使用者：${userText}`)
      console.log(`無相界（${charCount(text)} 字${tic}）：${text}`)
      console.log('')
      recentTurns.push(
        { role: 'user', content: userText },
        { role: 'assistant', content: text },
      )
    }
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
