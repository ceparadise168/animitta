import { replyMessage, replyWithQuickReply } from './line.mjs'
import { clearMemory } from './services/memory.mjs'

const SCRIPTURE_STARTERS = [
  { quote: '過去心不可得，現在心不可得，未來心不可得。', hook: '如果三種心都不可得，那現在在想事情的是誰？' },
  { quote: '凡所有相，皆是虛妄。', hook: '你今天有沒有看到什麼「相」，是你很想抓住的？' },
  { quote: '菩薩應無所住而生其心。', hook: '你覺得你的心，最近住在哪裡？' },
  { quote: '一切有為法，如夢幻泡影，如露亦如電，應作如是觀。', hook: '如果人生是一場夢，你最想在夢裡做什麼？' },
  { quote: '若菩薩不住相布施，其福德不可思量。', hook: '你最近有沒有做過什麼事，是不求回報但做完很開心的？' },
  { quote: '如來者，無所從來，亦無所去，故名如來。', hook: '如果沒有來也沒有去，那我們現在在哪裡？' },
  { quote: '若心有住，即為非住。', hook: '聽起來有點繞，你覺得這句在說什麼？' },
]

const ABOUT_MESSAGE =
  '這個聊天機器人源自我在昇恆昌任職期間，受公司理念啟發而萌生的一個小專案，希望能讓更多人認識《金剛經》，也能在這裡聊聊天、說說心裡的煩惱。\n\n' +
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
  if (data === 'confirm:clear') {
    await clearMemory(userId)
    return replyMessage(replyToken, '好的，記憶已清空 ✨ 我們從這裡重新開始')
  }
  if (data === 'confirm:cancel') {
    return replyMessage(replyToken, '好的，那我們繼續 😊')
  }
}

async function handleCasualChat(replyToken) {
  const pick = SCRIPTURE_STARTERS[Math.floor(Math.random() * SCRIPTURE_STARTERS.length)]
  const text = `嗨～今天想跟你分享一句金剛經：\n\n「${pick.quote}」\n\n${pick.hook}`
  return replyMessage(replyToken, text)
}

async function handleClearMemory(replyToken) {
  return replyWithQuickReply(
    replyToken,
    '確定要清除記憶嗎？這次之後我就會忘掉我們之前所有的對話喔',
    [
      { label: '確定', data: 'confirm:clear' },
      { label: '取消', data: 'confirm:cancel' },
    ]
  )
}
