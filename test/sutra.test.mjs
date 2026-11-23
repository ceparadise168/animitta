import { describe, it, expect } from '@jest/globals'
import { passagesFor, passageNote, DAILY_LINES, todaysLine, todaysLineReply } from '../lambda/sutra.mjs'
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

  it.each([
    ['金剛經第十四章在講什麼', ['離相寂滅分第十四']],
    ['金剛經第14品在講什麼', ['離相寂滅分第十四']],
    ['金剛經十四分在講什麼', ['離相寂滅分第十四']],
    ['第１４分是什麼', ['離相寂滅分第十四']],
    ['第卅二分在講什麼', ['應化非真分第三十二']],
    ['第十四分跟第十五分差在哪', ['離相寂滅分第十四', '持經功德分第十五']],
  ])('finds the chapter however "%s" writes it', (text, titles) => {
    expect(titlesFor(text)).toEqual(titles)
  })

  it.each(['再等我第三分鐘', '第二分店在哪', '拿了第一分之後就輸了', '金剛經讓我十分感動', '金剛經我才讀了三分之一'])(
    'does not read "%s" as a chapter',
    (text) => {
      expect(titlesFor(text)).toEqual([])
    },
  )

  it.each([
    ['金剛經怎麼講忍辱', ['離相寂滅分第十四']],
    ['四句偈是哪四句', ['法身非相分第二十六', '應化非真分第三十二']],
    ['須菩提是什麼意思', ['善現啟請分第二']],
    ['金剛經的結尾在講什麼', ['應化非真分第三十二']],
    ['金剛經開頭在講什麼', ['法會因由分第一']],
    ['金剛經裡的筏是什麼比喻', ['正信希有分第六']],
    ['金剛經的最後一句是什麼', ['應化非真分第三十二']],
    ['金剛經的第一句是什麼', ['法會因由分第一']],
    ['金剛經哪裡說到恆河沙', ['無為福勝分第十一']],
    ['金剛經怎麼說無為法', ['無得無說分第七']],
    ['金剛經的無我是什麼', ['究竟無我分第十七']],
    ['金剛經講的無相是什麼意思', ['如理實見分第五']],
    ['金剛經的六如偈', ['應化非真分第三十二']],
    ['筏喻是什麼意思', ['正信希有分第六']],
    ['無所住是什麼意思', ['莊嚴淨土分第十', '妙行無住分第四']],
    ['金剛經裡須菩提為什麼哭', ['離相寂滅分第十四']],
    ['五眼是什麼', ['一體同觀分第十八']],
    ['離相寂滅那一分在講什麼', ['離相寂滅分第十四']],
    ['如是我聞是什麼意思', ['法會因由分第一']],
    ['信受奉行是什麼意思', ['應化非真分第三十二']],
  ])('finds the chapter for the topic in "%s"', (text, titles) => {
    expect(titlesFor(text)).toEqual(titles)
  })

  it.each(['我一直在忍辱負重', '我相信你', '我相信金剛經會有幫助', '最近去廟裡布施了一點錢', '這部電影的結尾好感人', '無相界跟金剛經有什麼關係'])(
    'leaves the everyday use of a topic word alone: "%s"',
    (text) => {
      expect(titlesFor(text)).toEqual([])
    },
  )

  describe('found in a second review (2026-11-23)', () => {
    it.each([["第十四分可以講一下嗎", "離相寂滅分第十四"], ["第十四分我看不懂", "離相寂滅分第十四"], ["我想問第十四分在講什麼", "離相寂滅分第十四"], ["請問一下第十四分在講什麼", "離相寂滅分第十四"], ["第十四分講啥", "離相寂滅分第十四"], ["幫我解釋第十四分", "離相寂滅分第十四"], ["金剛經廿一分在講什麼", "非說所說分第二十一"], ["金剛經第１２品", "尊重正教分第十二"], ["離相寂滅在講什麼", "離相寂滅分第十四"], ["應化非真是什麼意思", "應化非真分第三十二"], ["什麼是五眼", "一體同觀分第十八"], ["誰是須菩提", "善現啟請分第二"], ["須菩提問了佛什麼問題", "善現啟請分第二"], ["須菩提哭的那段在哪一分", "離相寂滅分第十四"], ["應無所住而生其心在哪一分", "莊嚴淨土分第十"]])('finds the chapter for "%s"', (text, title) => {
      expect(titlesFor(text)).toEqual([title])
    })

    it.each(["我今天接受記者訪問", "他受記者專訪 好緊張", "五眼是哪五個國家", "我媽一直念佛經 為什麼叫我也要念", "金剛經為什麼叫人要放下執著", "第一分跟第二分都是他拿的", "第一分館跟第二分館哪個近", "第一分公司跟第二分公司", "念一部金剛經大概要30分", "金剛經測驗我只考了20分", "我給金剛經打十分", "我要經上海轉機", "未經上級同意不能請假", "我們行經中山路", "心經裡說的無我是什麼", "聖經上說要愛人如己 布施窮人", "第一分是在第幾局拿的", "念佛經能不能上九品?", "我要去金剛經讀書會 第二分享人是我", "他無所住 到處借住朋友家"])('leaves "%s" alone', (text) => {
      expect(titlesFor(text)).toEqual([])
    })
  })

  describe('a question about the line the bot just quoted', () => {
    const turns = (reply) => [
      { role: 'user', content: '最近一直在想以前的事' },
      { role: 'assistant', content: reply },
    ]
    const quoted = turns('我想到一句：「過去心不可得，現在心不可得，未來心不可得。」不用急著懂它')

    it.each(['這句出自哪裡', '這句出自哪一分', '什麼意思', '我看不懂', '這段話是什麼意思？', '嗯嗯 這是什麼意思', '可以解釋一下嗎'])('finds the chapter of the quote for "%s"', (text) => {
      expect(titlesFor(text, quoted)).toEqual(['一體同觀分第十八'])
    })

    it.each(['嗯嗯', '我老闆那段話到底什麼意思', '他說的這句話是什麼意思', '這張照片出自哪裡', '我不懂我媽為什麼要這樣對我', '你在哪裡 我好想找人講話', '這段時間真的好累', '我看不懂這份合約'])(
      'needs the person to be asking about it, not "%s"',
      (text) => {
        expect(titlesFor(text, quoted)).toEqual([])
      },
    )

    it('ignores the person’s own words in quotes', () => {
      expect(titlesFor('這句是什麼意思', turns('你剛剛說「只能這樣過下去」，聽起來很累'))).toEqual([])
    })
  })
})

describe("today's line", () => {
  const at = (iso) => Date.parse(iso)

  it('is the same all day in Taipei, however often it is pressed', () => {
    expect(todaysLine(at('2026-11-23T00:00:00+08:00'))).toEqual(todaysLine(at('2026-11-23T23:59:59+08:00')))
  })

  it('moves on at midnight Taipei time, not UTC', () => {
    expect(todaysLine(at('2026-11-23T23:59:59+08:00'))).not.toEqual(todaysLine(at('2026-11-24T00:00:00+08:00')))
    expect(todaysLine(at('2026-11-24T07:59:59+08:00'))).toEqual(todaysLine(at('2026-11-24T00:00:00+08:00')))
  })

  it('goes through every line, in the sutra’s order, before coming back', () => {
    const days = DAILY_LINES.length
    const start = at('2026-11-23T12:00:00+08:00')
    const lines = Array.from({ length: days }, (_, d) => todaysLine(start + d * 86_400_000).line)
    expect(new Set(lines).size).toBe(days)
    expect(todaysLine(start + days * 86_400_000).line).toBe(lines[0])
  })

  it('finds its chapter when the person asks about it next', () => {
    const turns = [
      { role: 'user', content: '（按了選單的「每日一句」）' },
      { role: 'assistant', content: todaysLineReply(at('2026-11-23T09:00:00+08:00')) },
    ]
    const { chapter } = todaysLine(at('2026-11-23T09:00:00+08:00'))
    expect(titlesFor('這句是什麼意思', turns)).toEqual([chapter.title])
    expect(titlesFor('嗯 今天好累', turns)).toEqual([])
  })
})

describe('passageNote', () => {
  it('hands over the whole chapter and asks for word-for-word quotes', () => {
    const note = passageNote(passagesFor('應無所住而生其心是什麼意思'))
    expect(note).toContain('〈莊嚴淨土分第十〉')
    expect(note).toContain('不應住聲、香、味、觸、法生心，應無所住而生其心。')
    expect(note).toContain('加引號就逐字照抄原文')
    expect(note).toContain('不一定是他要問的')
    expect(note).toContain('他沒在問經文的話，就當沒看到')
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
