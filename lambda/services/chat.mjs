import { getContext, saveTurn, compressOldTurns, archiveSession } from './memory.mjs'
import { getProvider } from '../providers/index.mjs'
import { buildMessages } from '../prompt.mjs'
import { replyMessage, showLoadingIndicator } from '../line.mjs'

function stripMarkdown(text) {
  return text.replace(/[*#_~`>]/g, '')
}

export async function handleText(userId, replyToken, userText) {
  const provider = getProvider()

  showLoadingIndicator(userId).catch((err) => console.warn(err.message))

  const context = await getContext(userId)
  const { text } = await provider.chatCompletion(buildMessages({ ...context, userInput: userText }))
  const reply = stripMarkdown(text)
  await replyMessage(replyToken, reply)

  await remember(userId, context, userText, reply, provider)
}

// Every exchange the bot takes part in is written here, so a new way of
// talking to the bot cannot skip the session bookkeeping.
async function remember(userId, { previousSession }, userText, reply, provider) {
  if (previousSession) await archiveSession(userId, provider)
  await saveTurn(userId, userText, reply)
  await compressOldTurns(userId, provider)
}
