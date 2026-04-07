import { describe, it, expect } from '@jest/globals'
import { buildMessages, SYSTEM_PROMPT } from '../lambda/prompt.mjs'

describe('buildMessages', () => {
  it('returns system + few-shot + user when no summary or history', () => {
    const msgs = buildMessages({ summary: null, recentTurns: [], userInput: '你好' })
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toBe(SYSTEM_PROMPT)
    // few-shot: user + assistant
    expect(msgs[1].role).toBe('user')
    expect(msgs[2].role).toBe('assistant')
    // final user message
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: '你好' })
  })

  it('inserts summary as second system message when provided', () => {
    const msgs = buildMessages({
      summary: '使用者感到壓力',
      recentTurns: [],
      userInput: '你好',
    })
    expect(msgs[1].role).toBe('system')
    expect(msgs[1].content).toContain('使用者感到壓力')
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
})

describe('SYSTEM_PROMPT', () => {
  it('contains Diamond Sutra content', () => {
    expect(SYSTEM_PROMPT).toContain('金剛經')
    expect(SYSTEM_PROMPT).toContain('無相界')
  })
})
