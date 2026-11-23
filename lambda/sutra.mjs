import { readFileSync } from 'node:fs'

// 金剛經全文：鳩摩羅什譯，江味農校定本（維基文庫），32 分。
// The whole text is looked up here instead of sitting in the prompt. With all
// of it in the prompt the model got 3 of 6 questions about where a line is
// and what surrounds it right, at twice the input; given only the chapter the
// user's words come from, 8 of 9 (2026-11-22).
export const CHAPTERS = JSON.parse(readFileSync(new URL('./diamond-sutra.json', import.meta.url), 'utf8'))

const han = (text) => (text.match(/[一-鿿]/g) || []).join('')
const CHAPTER_HAN = CHAPTERS.map((c) => han(c.text))
const WHOLE_HAN = CHAPTER_HAN.join('')

// Four characters in a row is the shortest piece that reads as a quote
// (法尚應捨, 如筏喻者), and a message rarely needs more than two chapters.
const SHORTEST_QUOTE = 4
const LONGEST_LOOKED_FOR = 20
const MOST_CHAPTERS = 2

// These everyday sayings also occur in the sutra, so on their own they are
// small talk: 太不可思議了, 結果皆大歡喜. They count only when the message is
// plainly about the sutra. A four-character piece built on 須菩提 is the name
// being mentioned, not a quote.
const EVERYDAY_SAYINGS = ['不可思議', '皆大歡喜', '大千世界', '夢幻泡影', '一切眾生']
export const ABOUT_THE_SUTRA = /金剛經|經文|經裡|經中|經上|這部經|佛經|原文|出處|哪一分|第幾分|哪一段|佛說|佛陀/

function countsAsQuote(piece, aboutSutra) {
  if (piece.length > SHORTEST_QUOTE) return true
  if (piece.includes('須菩提')) return false
  return aboutSutra || !EVERYDAY_SAYINGS.includes(piece)
}

// The longest runs of the user's words that occur in the sutra, one per chapter.
function quotedIn(text) {
  const words = han(text)
  const aboutSutra = ABOUT_THE_SUTRA.test(text)
  for (let length = Math.min(words.length, LONGEST_LOOKED_FOR); length >= SHORTEST_QUOTE; length--) {
    const found = new Map()
    for (let i = 0; i + length <= words.length; i++) {
      const piece = words.slice(i, i + length)
      if (!WHOLE_HAN.includes(piece) || !countsAsQuote(piece, aboutSutra)) continue
      CHAPTER_HAN.forEach((chapterText, index) => {
        if (!found.has(index) && chapterText.includes(piece)) found.set(index, piece)
      })
    }
    if (found.size) {
      return [...found].map(([index, piece]) => ({
        chapter: CHAPTERS[index],
        why: `他這句話裡的「${piece}」出自〈${CHAPTERS[index].title}〉`,
      }))
    }
  }
  return []
}

/** The chapters the model should read before answering this message. */
export function passagesFor(userText) {
  return quotedIn(userText).slice(0, MOST_CHAPTERS)
}

export function passageNote(passages) {
  return (
    '（內部參考，不要念給他聽：他這句話提到的經文，程式查到的出處如下。講出處、上下文時以這段原文為準，不要憑印象。' +
    '加引號就逐字照抄原文；白話翻譯不要放進引號裡。他沒在問經文的話，不要因為看到這段就把話題帶到金剛經。）\n' +
    passages.map(({ chapter, why }) => `${why}。這一分的原文：\n${chapter.text}`).join('\n\n')
  )
}
