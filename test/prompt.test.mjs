import { describe, it, expect } from '@jest/globals'
import { buildMessages, SYSTEM_PROMPT } from '../lambda/prompt.mjs'

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
})
