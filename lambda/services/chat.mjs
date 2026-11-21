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

// For a fixed bot line that the next message may answer, such as the
// casual-chat opener. userSide records what the user did to get it.
export async function replyAndRemember(userId, replyToken, userSide, reply) {
  await replyMessage(replyToken, reply)
  await remember(userId, await getContext(userId), userSide, reply, getProvider())
}

// Every exchange the bot takes part in is written here, so a new way of
// talking to the bot cannot skip the session bookkeeping. The exchange is saved
// before any summarizing, so a failed summary never loses what was just said.
async function remember(userId, { previousSession }, userText, reply, provider) {
  await saveTurn(userId, userText, reply)
  if (previousSession) await archiveSession(userId, previousSession, provider)
  await compressOldTurns(userId, provider)
}
