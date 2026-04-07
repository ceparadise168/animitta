import { getContext, saveTurn, compressOldTurns } from './memory.mjs'
import { getProvider } from '../providers/index.mjs'
import { buildMessages } from '../prompt.mjs'
import { replyMessage, replyWithQuickReplyMessage, downloadContent, showLoadingIndicator } from '../line.mjs'

function stripMarkdown(text) {
  return text.replace(/[*#_~`>]/g, '')
}

export async function handleText(userId, replyToken, userText) {
  const provider = getProvider()

  // Show "typing..." indicator while LLM thinks
  showLoadingIndicator(userId).catch(() => {})

  const { summary, recentTurns } = await getContext(userId)

  const messages = buildMessages({ summary, recentTurns, userInput: userText })
  const { text: rawText, suggestions } = await provider.chatCompletion(messages)
  const response = stripMarkdown(rawText)

  if (suggestions.length > 0) {
    const items = suggestions.map((label) => ({
      label: label.slice(0, 20),
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
