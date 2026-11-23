import { describe, it, expect } from '@jest/globals'
import { passagesFor, passageNote } from '../lambda/sutra.mjs'
import { buildMessages } from '../lambda/prompt.mjs'
import { EVERYDAY_MESSAGES } from './fixtures/everyday-messages.mjs'

const titlesFor = (text, recentTurns) => passagesFor(text, recentTurns).map((p) => p.chapter.title)

describe('passagesFor', () => {
  it.each([
    ['應無所住而生其心是什麼意思', ['莊嚴淨土分第十']],
    ['「法尚應捨，何況非法」是什麼意思', ['正信希有分第六']],
    ['金剛經最後那首一切有為法的偈，前一句是什麼', ['應化非真分第三十二']],
    ['過去心不可得 那段在講什麼', ['一體同觀分第十八']],
    ['人生如夢幻泡影', ['應化非真分第三十二']],
  ])('finds the chapter "%s" quotes', (text, titles) => {
    expect(titlesFor(text)).toEqual(titles)
  })

  it('reads an everyday saying the sutra also has as a quote only when the message is about the sutra', () => {
    expect(titlesFor('太不可思議了吧 他居然真的辭職')).toEqual([])
    expect(titlesFor('金剛經裡說的不可思議是在講什麼').length).toBeGreaterThan(0)
  })

  it('gives at most two chapters', () => {
    expect(titlesFor('金剛經說的三千大千世界是什麼').length).toBe(2)
  })

  it.each(EVERYDAY_MESSAGES)('leaves everyday talk alone: "%s"', (text) => {
    expect(titlesFor(text)).toEqual([])
  })

  it.each([
    ['第十四分在講什麼', ['離相寂滅分第十四']],
    ['金剛經第三十二分我讀不懂', ['應化非真分第三十二']],
    ['第 6 分是什麼', ['正信希有分第六']],
    ['離相寂滅分在講什麼', ['離相寂滅分第十四']],
  ])('finds the chapter "%s" names', (text, titles) => {
    expect(titlesFor(text)).toEqual(titles)
  })

  it.each(['再等我第三分鐘', '第二分店在哪', '拿了第一分之後就輸了'])('does not read "%s" as a chapter', (text) => {
    expect(titlesFor(text)).toEqual([])
  })

  it.each([
    ['金剛經怎麼講忍辱', ['離相寂滅分第十四']],
    ['四句偈是哪四句', ['法身非相分第二十六', '應化非真分第三十二']],
    ['須菩提是什麼意思', ['善現啟請分第二']],
    ['金剛經的結尾在講什麼', ['應化非真分第三十二']],
    ['金剛經開頭在講什麼', ['法會因由分第一']],
    ['金剛經裡的筏是什麼比喻', ['正信希有分第六']],
  ])('finds the chapter for the topic in "%s"', (text, titles) => {
    expect(titlesFor(text)).toEqual(titles)
  })

  it.each(['我一直在忍辱負重', '我相信你', '我相信金剛經會有幫助', '最近去廟裡布施了一點錢', '這部電影的結尾好感人'])(
    'leaves the everyday use of a topic word alone: "%s"',
    (text) => {
      expect(titlesFor(text)).toEqual([])
    },
  )

  describe('a question about the line the bot just quoted', () => {
    const turns = (reply) => [
      { role: 'user', content: '最近一直在想以前的事' },
      { role: 'assistant', content: reply },
    ]
    const quoted = turns('我想到一句：「過去心不可得，現在心不可得，未來心不可得。」不用急著懂它')

    it('finds the chapter of the quote', () => {
      expect(titlesFor('這句出自哪裡', quoted)).toEqual(['一體同觀分第十八'])
      expect(titlesFor('什麼意思', quoted)).toEqual(['一體同觀分第十八'])
    })

    it('needs the person to be asking about it', () => {
      expect(titlesFor('嗯嗯', quoted)).toEqual([])
    })

    it('ignores the person’s own words in quotes', () => {
      expect(titlesFor('這句是什麼意思', turns('你剛剛說「只能這樣過下去」，聽起來很累'))).toEqual([])
    })
  })
})

describe('passageNote', () => {
  it('hands over the whole chapter and asks for word-for-word quotes', () => {
    const note = passageNote(passagesFor('應無所住而生其心是什麼意思'))
    expect(note).toContain('〈莊嚴淨土分第十〉')
    expect(note).toContain('不應住聲、香、味、觸、法生心，應無所住而生其心。')
    expect(note).toContain('加引號就逐字照抄原文')
    expect(note).toContain('不要因為看到這段就把話題帶到金剛經')
  })
})

describe('buildMessages with the sutra', () => {
  it('puts the chapter right before a message that quotes it', () => {
    const msgs = buildMessages({ summary: null, recentTurns: [], userInput: '應無所住而生其心是什麼意思' })
    expect(msgs.at(-2).role).toBe('system')
    expect(msgs.at(-2).content).toContain('〈莊嚴淨土分第十〉')
    expect(msgs.at(-1)).toEqual({ role: 'user', content: '應無所住而生其心是什麼意思' })
  })

  it('adds nothing to ordinary chat', () => {
    const msgs = buildMessages({ summary: null, recentTurns: [], userInput: '今天好累 真的累爆' })
    expect(msgs.some((m) => m.content.includes('這一分的原文'))).toBe(false)
  })
})
