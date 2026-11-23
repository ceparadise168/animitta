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

// 第十四分, 第 14 分 or 離相寂滅分: asked by chapter. 第三分鐘 and 第二分店 are not.
const CHAPTER_NUMBER = /第\s*([一二三四五六七八九十]{1,3}|\d{1,2})\s*分(.?)/g
const NOT_A_CHAPTER = /[鐘鍾之店局隊行院處區]/
const ASKING_ABOUT_IT = /^([在講說是的嗎呢？?，,。！!\s]|)$/
const DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

function chapterNumber(written) {
  if (/^\d+$/.test(written)) return Number(written)
  const parts = written.split('十')
  if (parts.length === 1) return DIGITS[written] ?? NaN
  if (parts.length > 2) return NaN
  const [tens, ones] = parts
  return (tens ? DIGITS[tens] ?? NaN : 1) * 10 + (ones ? DIGITS[ones] ?? NaN : 0)
}

function byChapterName(text) {
  const aboutSutra = ABOUT_THE_SUTRA.test(text)
  const byNumber = [...text.matchAll(CHAPTER_NUMBER)]
    .filter(([, , next]) => !NOT_A_CHAPTER.test(next) && (aboutSutra || ASKING_ABOUT_IT.test(next)))
    .map(([, written]) => CHAPTERS[chapterNumber(written) - 1])
    .filter(Boolean)
  const byTitle = CHAPTERS.filter((c) => text.includes(c.title.replace(/分第.+$/, '')))
  return [...byNumber, ...byTitle].map((chapter) => ({ chapter, why: `他問的是〈${chapter.title}〉` }))
}

// Asked by topic. A word that is also everyday talk (忍辱負重, 去廟裡布施)
// counts only next to a word about the sutra; names and terms of the sutra
// count on their own.
const TOPICS = [
  { words: /須菩提/, chapters: [2], alone: true, note: '須菩提是佛的弟子，經裡向佛提問的人，第一次開口在這一分' },
  { words: /燃燈佛|然燈佛|授記/, chapters: [10, 17], alone: true },
  { words: /歌利王/, chapters: [14], alone: true },
  {
    words: /四句偈/,
    chapters: [26, 32],
    alone: true,
    note: '經裡好幾分都說「乃至四句偈等」，沒有指明是哪四句；一般常舉的是下面兩首偈，兩首在經裡各只出現一次',
  },
  { words: /一合相/, chapters: [30], alone: true },
  { words: /五眼/, chapters: [18], alone: true },
  { words: /忍辱/, chapters: [14] },
  { words: /筏/, chapters: [6] },
  { words: /四相|我相人相|眾生相|壽者相/, chapters: [3] },
  { words: /布施/, chapters: [4] },
  { words: /微塵/, chapters: [30] },
  { words: /開頭|一開始|第一段/, chapters: [1] },
  { words: /結尾|最後一段|最後那段|最後一分|最後面/, chapters: [32] },
  { words: /經名|為什麼叫/, chapters: [13] },
]

function byTopic(text) {
  const aboutSutra = ABOUT_THE_SUTRA.test(text)
  return TOPICS.filter(({ words, alone }) => words.test(text) && (alone || aboutSutra)).flatMap(({ words, chapters, note }) =>
    chapters.map((n) => ({
      chapter: CHAPTERS[n - 1],
      why: `他問的「${text.match(words)[0]}」${note ? `：${note}。這段` : ''}在〈${CHAPTERS[n - 1].title}〉`,
    })),
  )
}

// 這句出自哪裡, 什麼意思, 看不懂: asking about a line the bot just quoted,
// such as today's line. Only quotes of six characters or more that are in the
// sutra count, so the user's own words in quotes (「只能這樣」) do not.
const REFERS_BACK = /這句|那句|這段|那段|出處|原文|出自|哪一分|第幾分|哪一段|哪裡來|在哪裡|什麼意思|不懂|怎麼解釋|在講什麼|在說什麼/

function referredBack(text, lastReply) {
  if (!lastReply || !REFERS_BACK.test(text)) return []
  return [...lastReply.matchAll(/「([^」]+)」/g)]
    .map(([, quote]) => han(quote))
    .filter((words) => words.length >= 6)
    .flatMap((words) => CHAPTERS.filter((_, i) => CHAPTER_HAN[i].includes(words)).slice(0, 1))
    .map((chapter) => ({ chapter, why: `他問的是你剛剛引的那句，出自〈${chapter.title}〉` }))
}

/**
 * The chapters the model should read before answering this message: the ones
 * it quotes, names or asks about, or the one a line the bot just quoted is from.
 */
export function passagesFor(userText, recentTurns = []) {
  const last = recentTurns.at(-1)
  const lastReply = last?.role === 'assistant' ? last.content : ''
  const seen = new Set()
  return [...quotedIn(userText), ...byChapterName(userText), ...referredBack(userText, lastReply), ...byTopic(userText)]
    .filter(({ chapter }) => !seen.has(chapter.title) && seen.add(chapter.title))
    .slice(0, MOST_CHAPTERS)
}

// 今天的一句: on a Taipei day everyone gets the same line, going through the
// sutra in order, so pressing again is never a fresh draw (that would be
// 抽籤). Each line is the text word for word, with its chapter; lines that read
// as a rebuke out of context (是人行邪道) are left out.
export const DAILY_LINES = [
  ['飯食訖，收衣缽，洗足已，敷座而坐。', 1],
  ['應云何住？云何降伏其心？', 2],
  ['菩薩於法，應無所住，行於布施。', 4],
  ['菩薩應如是布施，不住於相。', 4],
  ['凡所有相，皆是虛妄。若見諸相非相，即見如來。', 5],
  ['知我說法，如筏喻者，法尚應捨，何況非法。', 6],
  ['一切賢聖，皆以無為法而有差別。', 7],
  ['所謂佛法者，即非佛法。', 8],
  ['莊嚴佛土者，即非莊嚴，是名莊嚴。', 10],
  ['應無所住而生其心。', 10],
  ['如來說：世界，非世界，是名世界。', 13],
  ['信心清淨，則生實相。', 14],
  ['離一切諸相，則名諸佛。', 14],
  ['若心有住，則為非住。', 14],
  ['若菩薩心不住法而行布施，如人有目，日光明照，見種種色。', 14],
  ['如來者，即諸法如義。', 17],
  ['一切法皆是佛法。', 17],
  ['過去心不可得，現在心不可得，未來心不可得。', 18],
  ['諸心皆為非心，是名為心。', 18],
  ['說法者，無法可說，是名說法。', 21],
  ['是法平等，無有高下。', 23],
  ['以無我、無人、無眾生、無壽者，修一切善法。', 23],
  ['如來說有我者，則非有我，而凡夫之人以為有我。', 25],
  ['於法不說斷滅相。', 27],
  ['菩薩所作福德，不應貪著。', 28],
  ['如來者，無所從來，亦無所去，故名如來。', 29],
  ['一合相者，則是不可說；但凡夫之人貪著其事。', 30],
  ['於一切法，應如是知，如是見，如是信解，不生法相。', 31],
  ['不取於相，如如不動。', 32],
  ['一切有為法，如夢幻泡影，如露亦如電，應作如是觀。', 32],
]

const TAIPEI_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000

export function todaysLine(now = Date.now()) {
  const [line, chapterNumber] = DAILY_LINES[Math.floor((now + TAIPEI_OFFSET_MS) / DAY_MS) % DAILY_LINES.length]
  return { line, chapter: CHAPTERS[chapterNumber - 1] }
}

export function todaysLineReply(now = Date.now()) {
  const { line, chapter } = todaysLine(now)
  return (
    `今天的一句\n\n「${line}」\n——〈${chapter.title}〉\n\n` +
    '不用急著懂它。這句讓你想到什麼，或今天有哪個念頭一直回來，都可以跟我說'
  )
}

export function passageNote(passages) {
  return (
    '（內部參考，不要念給他聽：他這句話提到的經文，程式查到的出處如下。講出處、上下文時以這段原文為準，不要憑印象。' +
    '加引號就逐字照抄原文；白話翻譯不要放進引號裡。他沒在問經文的話，不要因為看到這段就把話題帶到金剛經。）\n' +
    passages.map(({ chapter, why }) => `${why}。這一分的原文：\n${chapter.text}`).join('\n\n')
  )
}
