import { describe, it, expect } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { SYSTEM_PROMPT } from '../lambda/prompt.mjs'
import { DAILY_LINES } from '../lambda/sutra.mjs'

// Every sutra line the bot is given or says on its own must be the text itself:
// the prompt rule says a quoted line comes word for word from the library, so a
// reworded line in the library becomes a misquote (2026-11-23: 5 of 14 were).
const chapters = JSON.parse(readFileSync(new URL('../lambda/diamond-sutra.json', import.meta.url), 'utf8'))
const han = (s) => (s.match(/[一-鿿]/g) || []).join('')
const chapterOf = (line) => chapters.find((c) => han(c.text).includes(han(line)))

describe('the Diamond Sutra text', () => {
  it('has all 32 chapters, titled in traditional characters, without a 密 for 蜜', () => {
    expect(chapters).toHaveLength(32)
    expect(chapters[20].title).toBe('非說所說分第二十一')
    expect(chapters.at(-1).title).toBe('應化非真分第三十二')
    expect(chapters[13].text).toContain('是名忍辱波羅蜜')
    expect(chapters.some((c) => c.text.includes('波羅密'))).toBe(false)
  })

  it('is the circulated text most people recite (流通本), not the Wikisource mix used before', () => {
    expect(han(chapters[7].text)).not.toContain('是名佛法')
    expect(han(chapters[13].text)).toContain('若心有住即為非住')
    expect(han(chapters[13].text)).toContain('如人入暗即無所見')
    expect(chapters.map((c) => han(c.text)).join('')).toHaveLength(5174)
  })
})

describe('the scripture library in the prompt', () => {
  const library = SYSTEM_PROMPT.split('<經文庫 — 純金剛經>')[1].split('</經文庫 — 純金剛經>')[0]
  const entries = library
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).match(/^(.*)（(.+)）$/).slice(1))

  it('still holds the fourteen lines', () => {
    expect(entries).toHaveLength(14)
  })

  it.each(entries)('quotes "%s" word for word, from the chapter it names', (line, title) => {
    expect(chapterOf(line)?.title).toBe(title)
  })
})

describe("today's lines", () => {
  it.each(DAILY_LINES)('quotes "%s" word for word from chapter %d', (line, chapterNumber) => {
    expect(han(chapters[chapterNumber - 1].text)).toContain(han(line))
  })

  it('are long enough to be found again when someone asks about one', () => {
    for (const [line] of DAILY_LINES) expect(han(line).length).toBeGreaterThanOrEqual(6)
  })
})
