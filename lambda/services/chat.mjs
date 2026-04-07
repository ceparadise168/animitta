import { getContext, saveTurn, compressOldTurns } from './memory.mjs'
import { getProvider } from '../providers/index.mjs'
import { buildMessages } from '../prompt.mjs'
import { replyMessage, replyWithQuickReplyMessage, downloadContent, showLoadingIndicator } from '../line.mjs'

const SUGGESTIONS_RE = /\n*\[建議回覆[:：]\s*(.+)\]\s*$/

function stripMarkdown(text) {
  return text.replace(/[*#_~`>]/g, '')
}

/**
 * Parse optional suggested replies from the end of a response.
 * Format: [建議回覆: 選項1 | 選項2]
 * Returns { text, suggestions } where suggestions may be empty.
 */
function parseSuggestions(response) {
  const match = response.match(SUGGESTIONS_RE)
  if (!match) return { text: response, suggestions: [] }

  const text = response.replace(SUGGESTIONS_RE, '').trimEnd()
  const suggestions = match[1]
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4) // LINE Quick Reply max 13, but keep it concise

  return { text, suggestions }
}

export async function handleText(userId, replyToken, userText) {
  const provider = getProvider()

  // Show "typing..." indicator while LLM thinks
  showLoadingIndicator(userId).catch(() => {})

  const { summary, recentTurns } = await getContext(userId)

  const messages = buildMessages({ summary, recentTurns, userInput: userText })
  const rawResponse = await provider.chatCompletion(messages)
  const cleaned = stripMarkdown(rawResponse)
  const { text: response, suggestions } = parseSuggestions(cleaned)

  if (suggestions.length > 0) {
    const items = suggestions.map((label) => ({
      label,
      text: label,
    }))
    await replyWithQuickReplyMessage(replyToken, response, items)
  } else {
    await replyMessage(replyToken, response)
  }

  await saveTurn(userId, userText, response)
  await compressOldTurns(userId, provider)
}

export async function handleAudio(userId, replyToken, messageId) {
  const provider = getProvider()

  const audioBuffer = await downloadContent(messageId)
  const userText = await provider.transcribeAudio(audioBuffer)

  await handleText(userId, replyToken, userText)
}
