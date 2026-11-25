// Asks the model about every daily line the way 多了解這一段 does, right after
// the line was shown, and prints each answer with its length. Exits 1 when the
// median answer runs past the prompt's 220 characters, as they all did before
// the question asked for a short one (2026-11-25). Length is all it judges:
// whether an answer reads the line rightly still takes a person reading them.
//
// Run:  node scripts/check-line-explanations.mjs [tries per line, default 1]
//       Uses .env ANTHROPIC_API_KEY and CHAT_MODEL_ANTHROPIC.
import 'dotenv/config'
import { AnthropicProvider } from '../lambda/providers/anthropic.mjs'
import { buildMessages } from '../lambda/prompt.mjs'
import { DAILY_LINES, askAboutLine, lineAt, lineReply } from '../lambda/sutra.mjs'

const TRIES = Number(process.argv[2] || 1)
if (!Number.isInteger(TRIES) || TRIES < 1) {
  console.error(`tries per line must be a whole number of at least 1, not ${process.argv[2]}`)
  process.exit(2)
}

const LONGEST = 220
const length = (text) => [...text.replace(/\s/g, '')].length
const provider = new AnthropicProvider({ backup: null })

async function explain(shown) {
  const recentTurns = [
    { role: 'user', content: '（按了選單的「每日一句」）' },
    { role: 'assistant', content: lineReply(shown, { first: true }) },
  ]
  const messages = buildMessages({ summary: null, recentTurns, userInput: askAboutLine(shown) })
  const { text } = await provider.chatCompletion(messages, { signal: AbortSignal.timeout(60_000) })
  return text
}

const asks = DAILY_LINES.flatMap((_, i) => Array.from({ length: TRIES }, () => lineAt(i)))
const lengths = []
for (let at = 0; at < asks.length; at += 6) {
  const batch = asks.slice(at, at + 6)
  const answers = await Promise.all(batch.map(explain))
  batch.forEach((shown, i) => {
    lengths.push(length(answers[i]))
    console.log(`\n### ${shown.index} ${shown.line}（${length(answers[i])} 字）\n${answers[i]}`)
  })
}

const median = lengths.toSorted((a, b) => a - b)[Math.floor(lengths.length / 2)]
const over = lengths.filter((n) => n > LONGEST).length
console.log(`\n${lengths.length} answers: median ${median} 字, ${over} over ${LONGEST}`)
process.exit(median <= LONGEST ? 0 : 1)
