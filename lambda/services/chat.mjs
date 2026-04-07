import { getContext, saveTurn, compressOldTurns } from './memory.mjs'
import { getProvider } from '../providers/index.mjs'
import { buildMessages } from '../prompt.mjs'
import { replyMessage, downloadContent } from '../line.mjs'

function stripMarkdown(text) {
  return text.replace(/[*#_~`>]/g, '')
}

export async function handleText(userId, replyToken, userText) {
  const provider = getProvider()

  const { summary, recentTurns } = await getContext(userId)

  const messages = buildMessages({ summary, recentTurns, userInput: userText })
  const rawResponse = await provider.chatCompletion(messages)
  const response = stripMarkdown(rawResponse)

  await replyMessage(replyToken, response)

  await saveTurn(userId, userText, response)
  await compressOldTurns(userId, provider)
}

export async function handleAudio(userId, replyToken, messageId) {
  const provider = getProvider()

  const audioBuffer = await downloadContent(messageId)
  const userText = await provider.transcribeAudio(audioBuffer)

  await handleText(userId, replyToken, userText)
}
