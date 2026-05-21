import { getContext, saveTurn, compressOldTurns, archiveSession } from './memory.mjs'
import { getProvider } from '../providers/index.mjs'
import { buildMessages } from '../prompt.mjs'
import {
  replyMessage,
  replyWithQuickReplyMessage,
  downloadContent,
  showLoadingIndicator,
} from '../line.mjs'

function stripMarkdown(text) {
  return text.replace(/[*#_~`>]/g, '')
}

const QUICK_REPLY_LABEL_MAX_LENGTH = 20

function formatQuickReplySuggestion(suggestion) {
  const text = stripMarkdown(suggestion).trim()
  if (!text) return null

  return {
    label:
      text.length > QUICK_REPLY_LABEL_MAX_LENGTH
        ? `${text.slice(0, QUICK_REPLY_LABEL_MAX_LENGTH - 1)}…`
        : text,
    text,
  }
}

export async function handleText(userId, replyToken, userText) {
  const provider = getProvider()

  showLoadingIndicator(userId).catch(() => {})

  const { summary, recentTurns, isStaleSession } = await getContext(userId)

  const effectiveTurns = isStaleSession ? [] : recentTurns

  const messages = buildMessages({
    summary,
    recentTurns: effectiveTurns,
    userInput: userText,
    isStaleSession,
  })
  const { text: rawText, suggestions = [] } = await provider.chatCompletion(messages)
  const response = stripMarkdown(rawText)
  const quickReplyItems = Array.isArray(suggestions)
    ? suggestions.slice(0, 3).map(formatQuickReplySuggestion).filter(Boolean)
    : []

  if (quickReplyItems.length > 0) {
    await replyWithQuickReplyMessage(replyToken, response, quickReplyItems)
  } else {
    await replyMessage(replyToken, response)
  }

  if (isStaleSession) {
    await archiveSession(userId, provider)
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
