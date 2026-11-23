import { describe, it, expect } from '@jest/globals'
import { buildMessages, SYSTEM_PROMPT, realPeopleParagraph } from '../lambda/prompt.mjs'

describe('buildMessages', () => {
  it('returns system prompt + demos + user when no summary or history', () => {
    const msgs = buildMessages({ summary: null, recentTurns: [], userInput: '你好' })
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toBe(SYSTEM_PROMPT)
    // demos as system message
    expect(msgs[1].role).toBe('system')
    expect(msgs[1].content).toContain('示範對話')
    // final user message
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: '你好' })
  })

  it('inserts summary after demos when provided', () => {
    const msgs = buildMessages({
      summary: '使用者感到壓力',
      recentTurns: [],
      userInput: '你好',
    })
    expect(msgs[2].role).toBe('system')
    expect(msgs[2].content).toContain('使用者感到壓力')
    expect(msgs[2].content).toContain('最新的使用者訊息優先')
  })

  it('includes recent turns before the new user message', () => {
    const recentTurns = [
      { role: 'user', content: '我很累' },
      { role: 'assistant', content: '辛苦了' },
    ]
    const msgs = buildMessages({ summary: null, recentTurns, userInput: '謝謝' })
    const lastThree = msgs.slice(-3)
    expect(lastThree[0]).toEqual({ role: 'user', content: '我很累' })
    expect(lastThree[1]).toEqual({ role: 'assistant', content: '辛苦了' })
    expect(lastThree[2]).toEqual({ role: 'user', content: '謝謝' })
  })

  it('gives the previous session as labelled background, not as live turns', () => {
    const msgs = buildMessages({
      summary: null,
      recentTurns: [],
      previousSession: {
        turns: [
          { role: 'user', content: '我媽昨天住院了' },
          { role: 'assistant', content: '嗯，這個很重' },
        ],
        idleMs: 3 * 3_600_000,
      },
      userInput: '她今天出院了',
    })
    const note = msgs.at(-2)
    expect(note.role).toBe('system')
    expect(note.content).toContain('隔了大約 3 小時')
    expect(note.content).toContain('使用者：我媽昨天住院了\n無相界：嗯，這個很重')
    expect(msgs.filter((m) => m.role !== 'system')).toEqual([{ role: 'user', content: '她今天出院了' }])
  })

  it('counts a gap of a day or more in days', () => {
    const msgs = buildMessages({
      summary: null,
      recentTurns: [],
      previousSession: { turns: [{ role: 'user', content: '嗨' }], idleMs: 50 * 3_600_000 },
      userInput: '我回來了',
    })
    expect(msgs.at(-2).content).toContain('隔了大約 2 天')
  })

  it('does not include fake user/assistant few-shot turns', () => {
    const msgs = buildMessages({ summary: null, recentTurns: [], userInput: '你好' })
    // Only system messages before the final user message
    const beforeUser = msgs.slice(0, -1)
    for (const msg of beforeUser) {
      expect(msg.role).toBe('system')
    }
  })
})

describe('SYSTEM_PROMPT', () => {
  it('contains Diamond Sutra content', () => {
    expect(SYSTEM_PROMPT).toContain('金剛經')
    expect(SYSTEM_PROMPT).toContain('無相界')
  })

  it('contains anti-hallucination rules for scripture', () => {
    expect(SYSTEM_PROMPT).toContain('加引號的引用必須逐字來自經文庫')
  })

  it('positions the product as user-first conversation, not image performance', () => {
    expect(SYSTEM_PROMPT).toContain('自在對話優先')
    expect(SYSTEM_PROMPT).toContain('先回到使用者正在求什麼')
    expect(SYSTEM_PROMPT).toContain('金剛經是底色，不是每次都要端出來')
    expect(SYSTEM_PROMPT).not.toContain('最核心紀律 — Image-first')
    expect(SYSTEM_PROMPT).not.toContain('你不是來照顧人的、是給畫面的人')
  })

  it('treats light emotional disclosure as a mode switch to ordinary presence', () => {
    expect(SYSTEM_PROMPT).toContain('使用者說「煩」「累」「卡」')
    expect(SYSTEM_PROMPT).toContain('第一件事不是寫出好看的比喻')
    expect(SYSTEM_PROMPT).toContain('先承認他正在煩')
  })

  it('keeps scripture conditional and behind the conversation', () => {
    expect(SYSTEM_PROMPT).toContain('金剛經是無相界的底色')
    expect(SYSTEM_PROMPT).toContain('引整句原文，適合')
    expect(SYSTEM_PROMPT).toContain('不適合：剛在抒發')
  })

  it('offers a way to real people once, when someone has been low for a while', () => {
    expect(SYSTEM_PROMPT).toContain('找真人聊也是一條路')
    expect(SYSTEM_PROMPT).toContain('一段對話最多提一次')
  })

  it('stops offering the free counselling for 15-45-year-olds once 2026 is over in Taipei', () => {
    const lastMinute = realPeopleParagraph(Date.parse('2026-12-31T23:59:00+08:00'))
    const newYear = realPeopleParagraph(Date.parse('2027-01-01T00:00:00+08:00'))
    expect(lastMinute).toContain('心理健康支持方案')
    expect(newYear).not.toContain('心理健康支持方案')
    expect(newYear).toContain('社區心理衛生中心')
  })

  it('gives the two 24-hour suicide hotlines first, and says when 1980 is closed', () => {
    expect(SYSTEM_PROMPT).toContain('1925 安心專線和 1995 生命線，兩支都 24 小時有人接')
    expect(SYSTEM_PROMPT).toContain('1980 張老師不是 24 小時')
    const demos = buildMessages({ summary: null, recentTurns: [], userInput: '嗨' })[1].content
    expect(demos).toContain('1925 安心專線、1995 生命線，24 小時都有人接')
  })
})
