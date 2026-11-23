import { describe, it, expect } from '@jest/globals'
import { talksOfEndingLife, CRISIS_FALLBACK_REPLY } from '../lambda/crisis.mjs'

// Written for the tests, partly by an adversarial review (2026-11-23); no real
// user wrote them.
const ENDING_LIFE = [
  '我快撐不住了 想死',
  '我真的不想活了',
  '我真的不想再活了',
  '我真的不想再活下去了',
  '活不下去了',
  '有時候會想自殺',
  '我想要死',
  '我想要去死',
  '我想要死掉',
  '我想自我了斷',
  '今天又割腕了',
  '我又劃手了',
  '我想割手',
  '我買了炭 想燒炭',
  '想從頂樓跳樓',
  '想從頂樓跳下去',
  '乾脆一了百了',
  '想結束這一切',
  '我想結束自己的生命',
  '我去死好了',
  '好想死喔',
  '我想死他也不會在乎吧',
  '我想死她大概也不會哭',
  '笑死 但我是真的想死',
  '難過到想死',
  '我想吞安眠藥',
  '我已經吞了一整罐安眠藥',
  '我已經寫好遺書了',
  '睡著就不要再醒來',
  '希望明天不要醒來',
  '我不想存在了',
  '如果我不在了大家會比較好',
  '死掉就好了',
  '我想離開這個世界',
  '我把藥都囤好了',
  '我吃了一整排藥',
  '我想去跳河',
  '我又割了',
  '我要結束我的生命',
  '我想了斷',
  '我想要結束自己',
  '乾脆死一死算了',
  '我不想醒來了',
  '我想睡著就不要醒來',
  '我想睡一覺就不要再醒',
  'I want to die',
  '我不想再醒過來',
  '我累到想死，是真的，不是開玩笑',
  '（傳了一張貼圖：sad，上面寫著「不想活了」）',
]

const EVERYDAY = [
  '笑死 我同事今天又出包',
  '今天累死了 加班到十點',
  '累到想死',
  '熱得想死',
  '笑到想死',
  '今天被老闆罵到想死',
  '這題數學難到想死',
  '尷尬到想死',
  '痛到想死 牙齒好痛',
  '辣到想死',
  '想死你了 好久不見',
  '想死人了',
  '我想死去的爺爺',
  '好想死去的阿公',
  '我好想死掉的那隻狗',
  '你想死是不是 敢偷吃我的布丁',
  '哈哈哈笑死 想死喔你',
  '這家店在跳樓大拍賣',
  '跳樓價出清',
  '今天去六福村玩跳樓機',
  '熱死了',
  '氣死我了',
  '你去死啦',
  '看到自殺式攻擊的新聞好可怕',
  '自殘式購物',
  '尋死覓活的那種劇情',
  '我朋友是做自殺防治的社工',
  '不想活在別人的期待裡',
  '我不想活成我爸那樣',
  '要怎麼避免傷害自己的膝蓋',
  '吞藥丸好難 我都要配果汁',
  '我吃安眠藥才睡得著',
  '早上不想起床',
  '死線快到了',
  '丟臉死了想死',
  '熱死了想死',
  '累死了想死',
  '累到不想活',
  '想死的心都有了，報告又被退',
  '上吊式的表情包好好笑',
  '這遊戲根本自殺關卡',
  '吞藥的時候卡在喉嚨',
  '辭職算了 一了百了',
  '我寧願一了百了把這份工作辭掉',
  '物價這麼高根本活不下去',
  '油價又漲 小資族活不下去',
  '這個月薪水好少活不下去了啦哈哈',
  '我想結束自己的事業重新開始',
]

describe('talksOfEndingLife', () => {
  it.each(ENDING_LIFE)('hears "%s"', (text) => {
    expect(talksOfEndingLife(text)).toBe(true)
  })

  it.each(EVERYDAY)('lets everyday talk "%s" pass', (text) => {
    expect(talksOfEndingLife(text)).toBe(false)
  })

  it('hears nothing when there are no words', () => {
    for (const nothing of [undefined, null, 123, {}]) expect(talksOfEndingLife(nothing)).toBe(false)
  })
})

describe('CRISIS_FALLBACK_REPLY', () => {
  it('gives the two hotlines that can be called at any hour, and the emergency numbers', () => {
    for (const number of ['1925', '1995', '119', '110']) expect(CRISIS_FALLBACK_REPLY).toContain(number)
  })

  it('does not promise that someone always picks up', () => {
    expect(CRISIS_FALLBACK_REPLY).not.toContain('都有人接')
    expect(CRISIS_FALLBACK_REPLY).toContain('打不通就換另一支')
  })
})
