import { OpenAiProvider } from './openai.mjs'
import { AnthropicProvider } from './anthropic.mjs'

let cached = null

export function getProvider() {
  if (cached) return cached
  const name = process.env.LLM_PROVIDER || 'openai'
  switch (name) {
    case 'openai':
      cached = new OpenAiProvider()
      break
    case 'anthropic':
      cached = new AnthropicProvider()
      break
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${name}`)
  }
  return cached
}
