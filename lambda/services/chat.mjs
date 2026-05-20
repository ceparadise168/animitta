import { getContext, saveTurn, compressOldTurns, archiveSession } from './memory.mjs'
import { getProvider } from '../providers/index.mjs'
import { buildMessages } from '../prompt.mjs'
import { replyMessage, downloadContent, showLoadingIndicator } from '../line.mjs'

function stripMarkdown(text) {
  return text.replace(/[*#_~`>]/g, '')
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
  const { text: rawText } = await provider.chatCompletion(messages)
  const response = stripMarkdown(rawText)

  await replyMessage(replyToken, response)

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
