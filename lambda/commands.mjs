import { replyMessage, replyWithQuickReply } from './line.mjs'
import { clearMemory } from './services/memory.mjs'

const CASUAL_CHAT_STARTERS = [
  '嗨，這邊很隨意，不用拘束\n\n想講最近煩你的事、一個轉不掉的念頭，或想問我金剛經裡的哪句話，都可以。不用先想好怎麼說，現在心裡最放不下的那件事，直接講出來就好',
  '今天不一定要從經文開始\n\n想抒發、想問點什麼、想聊金剛經，都行。腦袋裡本來怎麼想，就怎麼講，講得亂也沒關係',
  '我在\n\n可以聊日常，也可以聊那些沒有標準答案的事。想聊哪一種都可以',
  '如果你想聽金剛經裡的一句話，我會想到：「過去心不可得、現在心不可得、未來心不可得。」\n\n不用急著懂它。你也可以就說說看，今天有哪個念頭一直回來',
  '隨意聊聊就從一句話開始\n\n最近讓你卡住的，是一件事、一個人，還是一個一直冒出來的念頭',
]

const ABOUT_MESSAGE =
  '無相界是一個帶著金剛經視角的自在聊天空間。你可以抒發煩惱、問生活裡卡住的事，也可以單純想理解《金剛經》在說什麼。\n\n' +
  '它不是籤詩機，也不是佛學講堂。金剛經在這裡比較像底色：需要時拿來照一下，不需要時就好好聊天。\n\n' +
  '目前由我個人自費維護。如果你覺得有幫助，歡迎分享給朋友；若想將這份善意延續下去，也歡迎隨喜捐款給你支持的慈善團體。\n\n' +
  '有任何建議，都歡迎寫信給我：erictu.engineer@gmail.com'

export async function handleCommand(userId, replyToken, command) {
  switch (command) {
    case '@隨意聊聊':
      return handleCasualChat(replyToken)
    case '@清除記憶':
      return handleClearMemory(replyToken)
    case '@關於':
      return replyMessage(replyToken, ABOUT_MESSAGE)
    default:
      return false
  }
}

export async function handlePostback(userId, replyToken, data) {
  if (data === 'action=casual_chat') {
    return handleCasualChat(replyToken)
  }
  if (data === 'confirm:clear') {
    await clearMemory(userId)
    return replyMessage(replyToken, '好的，記憶已清空 ✨ 我們從這裡重新開始')
  }
  if (data === 'confirm:cancel') {
    return replyMessage(replyToken, '好的，那我們繼續 😊')
  }
}

async function handleCasualChat(replyToken) {
  const text =
    CASUAL_CHAT_STARTERS[Math.floor(Math.random() * CASUAL_CHAT_STARTERS.length)]
  return replyMessage(replyToken, text)
}

async function handleClearMemory(replyToken) {
  return replyWithQuickReply(
    replyToken,
    '確定要清除記憶嗎？這次之後我就會忘掉我們之前所有的對話喔',
    [
      { label: '確定', data: 'confirm:clear', inputOption: 'openKeyboard' },
      { label: '取消', data: 'confirm:cancel', inputOption: 'openKeyboard' },
    ]
  )
}
