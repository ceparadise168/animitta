// When the bot breaks while someone says they want to end their life, the
// apology still has to give them a number that answers at any hour. The words
// are kept narrow on purpose: everyday exaggeration such as 累到想死, 想死你了
// or 跳樓大拍賣 must not pull out the hotlines.
const ENDING_LIFE =
  /想死|想去死|我去死|不想活|活不下去|自殺|輕生|尋死|結束(自己的)?生命|了結自己|一了百了|割腕|燒炭|上吊|跳樓|吞藥|吞安眠藥|自殘|傷害自己|死了算了|不想再醒來|不要再醒來/

const EVERYDAY = /(笑|累|熱|冷|餓|睏|忙|無聊|飽|撐)(到|得)想死|想死(你|妳|他|她|我了|了你)|跳樓(大)?(拍賣|價|特價|出清)|自殺式/g

export const CRISIS_FALLBACK_REPLY =
  '我這邊剛好出了問題，沒辦法好好回你。但你說的我看到了。\n\n' +
  '現在很難受的話，1925 安心專線、1995 生命線 24 小時都有人接。如果有立即的危險，直接打 119 或 110。'

export function talksOfEndingLife(text = '') {
  return ENDING_LIFE.test(text.replace(/\s+/g, '').replace(EVERYDAY, ''))
}
