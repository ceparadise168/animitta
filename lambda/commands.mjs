import { replyMessage, replyWithQuickReply } from './line.mjs'
import { clearMemory, saveFeedback, setPendingFeedback, getPendingFeedback, deletePendingFeedback } from './services/memory.mjs'

const SCRIPTURE_STARTERS = [
  { quote: '過去心不可得，現在心不可得，未來心不可得。', hook: '如果三種心都不可得，那現在在想事情的是誰？' },
  { quote: '凡所有相，皆是虛妄。', hook: '你今天有沒有看到什麼「相」，是你很想抓住的？' },
  { quote: '菩薩應無所住而生其心。', hook: '你覺得你的心，最近住在哪裡？' },
  { quote: '一切有為法，如夢幻泡影，如露亦如電，應作如是觀。', hook: '如果人生是一場夢，你最想在夢裡做什麼？' },
  { quote: '若菩薩不住相布施，其福德不可思量。', hook: '你最近有沒有做過什麼事，是不求回報但做完很開心的？' },
  { quote: '如來者，無所從來，亦無所去，故名如來。', hook: '如果沒有來也沒有去，那我們現在在哪裡？' },
  { quote: '若心有住，即為非住。', hook: '聽起來有點繞，你覺得這句在說什麼？' },
]

/**
 * Check if the user's text message is a feedback follow-up.
 * Returns true if handled, false if it's a normal message.
 */
export async function tryHandleFeedbackText(userId, replyToken, text) {
  const pending = await getPendingFeedback(userId)
  if (!pending) return false

  await deletePendingFeedback(userId)
  await saveFeedback(userId, 'good_detail', text)
  await replyMessage(replyToken, '收到，謝謝你的分享 🙏')
  return true
}

export async function handleCommand(userId, replyToken, command) {
  switch (command) {
    case '@隨意聊聊':
      return handleCasualChat(replyToken)
    case '@重新開始':
      return handleRestart(replyToken)
    case '@回饋':
      return handleFeedbackPrompt(replyToken)
    default:
      return false
  }
}

export async function handlePostback(userId, replyToken, data) {
  if (data === 'confirm:clear') {
    await clearMemory(userId)
    return replyMessage(replyToken, '記憶已清空，我們重新開始吧 ✨')
  }
  if (data === 'confirm:cancel') {
    return replyMessage(replyToken, '好的，那我們繼續 😊')
  }
  if (data === 'feedback:good') {
    await saveFeedback(userId, 'good')
    await setPendingFeedback(userId)
    return replyMessage(replyToken, '謝謝！方便說一下哪裡有幫助嗎？\n\n（直接打字，或不回也沒關係）')
  }
  if (data === 'feedback:ok') {
    await saveFeedback(userId, 'ok')
    return replyMessage(replyToken, '好的，謝謝你的回饋 🙏')
  }
}

async function handleCasualChat(replyToken) {
  const pick = SCRIPTURE_STARTERS[Math.floor(Math.random() * SCRIPTURE_STARTERS.length)]
  const text = `嗨～今天想跟你分享一句金剛經：\n\n「${pick.quote}」\n\n${pick.hook}`
  return replyMessage(replyToken, text)
}

async function handleRestart(replyToken) {
  return replyWithQuickReply(
    replyToken,
    '確定要重新開始嗎？之前的對話記憶會清空喔',
    [
      { label: '確定', data: 'confirm:clear' },
      { label: '取消', data: 'confirm:cancel' },
    ]
  )
}

async function handleFeedbackPrompt(replyToken) {
  return replyWithQuickReply(
    replyToken,
    '這次聊天覺得如何？',
    [
      { label: '👍 有收穫', data: 'feedback:good' },
      { label: '👋 還好', data: 'feedback:ok' },
    ]
  )
}
