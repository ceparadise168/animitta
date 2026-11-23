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
