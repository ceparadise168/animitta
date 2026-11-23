import { describe, it, expect } from '@jest/globals'
import { talksOfEndingLife, CRISIS_FALLBACK_REPLY } from '../lambda/crisis.mjs'

const ENDING_LIFE = [
  '我快撐不住了 想死',
  '我真的不想活了',
  '活不下去了',
  '有時候會想自殺',
  '今天又割腕了',
  '我買了炭 想燒炭',
  '想從頂樓跳樓',
  '乾脆一了百了',
  '我想結束自己的生命',
  '我去死好了',
  '好想死喔',
  '笑死 但我是真的想死',
  '我想吞安眠藥',
  '睡著就不要再醒來',
  '（傳了一張貼圖：sad，上面寫著「不想活了」）',
]

const EVERYDAY = [
  '笑死 我同事今天又出包',
  '今天累死了 加班到十點',
  '累到想死',
  '熱得想死',
  '笑到想死',
  '想死你了 好久不見',
  '這家店在跳樓大拍賣',
  '跳樓價出清',
  '熱死了',
  '氣死我了',
  '你去死啦',
  '看到自殺式攻擊的新聞好可怕',
  '我吃安眠藥才睡得著',
  '早上不想起床',
  '死線快到了',
]

describe('talksOfEndingLife', () => {
  it.each(ENDING_LIFE)('hears "%s"', (text) => {
    expect(talksOfEndingLife(text)).toBe(true)
  })

  it.each(EVERYDAY)('lets everyday talk "%s" pass', (text) => {
    expect(talksOfEndingLife(text)).toBe(false)
  })

  it('hears nothing when there are no words', () => {
    expect(talksOfEndingLife(undefined)).toBe(false)
  })
})

describe('CRISIS_FALLBACK_REPLY', () => {
  it('gives the two hotlines that answer at any hour, and the emergency numbers', () => {
    for (const number of ['1925', '1995', '119', '110']) expect(CRISIS_FALLBACK_REPLY).toContain(number)
  })
})
