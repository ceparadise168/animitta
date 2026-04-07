import { getContext, saveTurn, compressOldTurns } from './memory.mjs'
import { getProvider } from '../providers/index.mjs'
import { buildMessages } from '../prompt.mjs'
import { replyMessage, replyWithQuickReplyMessage, downloadContent, showLoadingIndicator } from '../line.mjs'

const EXPLICIT_RE = /\n*\[建議回覆[:：]\s*(.+)\]\s*$/
// Match "A、B、還是C" or "A，還是B" or "「A」還是「B」" patterns in the last sentence
const NATURAL_OR_RE = /[，、]?\s*還是\s*/
// Match "三個重點：A、B、C" or "兩個方向：A和B" patterns
const NATURAL_LIST_RE = /[:：]([^.。\n]+)[。？?]?\s*$/

function stripMarkdown(text) {
  return text.replace(/[*#_~`>]/g, '')
}

/**
 * Parse suggested replies from the end of a response.
 * First tries explicit [建議回覆:] format.
 * Then tries to detect natural language options in the last sentence.
 */
function parseSuggestions(response) {
  // 1. Try explicit format
  const explicit = response.match(EXPLICIT_RE)
  if (explicit) {
    const text = response.replace(EXPLICIT_RE, '').trimEnd()
    const suggestions = explicit[1].split('|').map((s) => s.trim()).filter(Boolean).slice(0, 4)
    return { text, suggestions }
  }

  // 2. Try natural "A還是B" in the last sentence
  const lines = response.trimEnd().split('\n')
  const lastLine = lines[lines.length - 1]

  if (NATURAL_OR_RE.test(lastLine) && lastLine.includes('？') || lastLine.includes('?')) {
    // Extract the question part — look for the options before ?
    const qMark = lastLine.lastIndexOf('？') !== -1 ? lastLine.lastIndexOf('？') : lastLine.lastIndexOf('?')
    const questionPart = lastLine.substring(0, qMark)
    // Find the start of options — look backwards for a sentence break
    const optionStart = Math.max(
      questionPart.lastIndexOf('：'),
      questionPart.lastIndexOf('，是'),
      questionPart.lastIndexOf('想先'),
      questionPart.lastIndexOf('比較想'),
    )
    if (optionStart > 0) {
      const optionStr = questionPart.substring(optionStart + 1).trim()
      const parts = optionStr.split(NATURAL_OR_RE).map((s) => s.replace(/[「」『』]/g, '').trim()).filter(Boolean)
      if (parts.length >= 2 && parts.length <= 4 && parts.every((p) => p.length <= 20)) {
        return { text: response, suggestions: parts }
      }
    }
  }

  // 3. Try quoted list "「A、B、C」" anywhere in last 2 lines
  const tail = lines.slice(-2).join('\n')
  const quotedList = tail.match(/[「『]([^」』]+[、][^」』]+)[」』]/)
  if (quotedList) {
    const items = quotedList[1].split(/[、和與]/).map((s) => s.trim()).filter(Boolean)
    if (items.length >= 2 && items.length <= 4 && items.every((p) => p.length <= 20)) {
      return { text: response, suggestions: items }
    }
  }

  // 4. Try "三個重點：A、B、C" pattern at the end
  const listMatch = lastLine.match(NATURAL_LIST_RE)
  if (listMatch) {
    const items = listMatch[1].split(/[、和與]/).map((s) => s.replace(/[「」『』]/g, '').trim()).filter(Boolean)
    if (items.length >= 2 && items.length <= 4 && items.every((p) => p.length <= 20)) {
      return { text: response, suggestions: items }
    }
  }

  return { text: response, suggestions: [] }
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
