import { readFileSync } from 'node:fs'

// 金剛經全文：鳩摩羅什譯，流通本（報佛恩網・般若文海 book.bfnn.org/books/0040.htm），the text
// most people recite, chosen by the owner on 2026-11-23. It carries no chapter
// titles, so the 32 titles (昭明太子's division) are kept from the previous
// text, split at the same places. Its words differ from that text only in
// single characters (即/則, 恒/恆, 暗/闇, 繞/遶) and in lacking 是名佛法 in the
// eighth chapter, as 江味農's collation and CBETA T0235 lack it too.
//
// The whole text is looked up here instead of sitting in the prompt. With all
// of it in the prompt the model got 3 of 6 questions about where a line is
// and what surrounds it right, at twice the input; given only the chapter the
// user's words come from, 8 of 9 (2026-11-22).
export const CHAPTERS = JSON.parse(readFileSync(new URL('./diamond-sutra.json', import.meta.url), 'utf8'))

// Printings of the sutra write some characters differently, so the lookup
// reads them as one: someone who recites 若心有住則為非住 still finds the
// chapter that prints 即為非住.
const SAME_IN_PRINTINGS = { 則: '即', 恆: '恒', 闇: '暗', 遶: '繞' }
const han = (text) => (text.match(/[一-鿿]/g) || []).map((c) => SAME_IN_PRINTINGS[c] ?? c).join('')
const CHAPTER_HAN = CHAPTERS.map((c) => han(c.text))
const WHOLE_HAN = CHAPTER_HAN.join('')
const MOST_CHAPTERS = 2

// Words that say the message is about this sutra. Not 佛經, 經裡 or 經上 on
// their own: 心經裡, 法華經裡 and 聖經上 are other books, and 已經上班 is none.
export const ABOUT_THE_SUTRA = /金剛經|這部經|經文|佛說|佛陀|哪一分(?!鐘)|第幾分(?!鐘)/

// Five characters of the sutra in a row read as a quote. Four do only for its
// best-known short phrases, or when the message is plainly about the sutra:
// many four-character runs of it are everyday Chinese (世界所有, 如是如是,
// 不可思議, 皆大歡喜). A four-character piece built on 須菩提 is the name.
const SHORTEST_LOOKED_FOR = 4
const SHORTEST_QUOTE = 5
const LONGEST_LOOKED_FOR = 20
const FAMOUS_SHORT_QUOTES = [
  '法尚應捨', '何況非法', '如筏喻者', '凡所有相', '皆是虛妄', '諸相非相', '即見如來', '如如不動',
  '不取於相', '降伏其心', '應無所住', '無法可說', '是名說法', '即非莊嚴', '是名莊嚴', '即非佛法',
  '如是我聞', '信受奉行',
]

function countsAsQuote(piece, aboutSutra) {
  if (piece.length >= SHORTEST_QUOTE) return true
  if (piece.includes('須菩提')) return false
  return aboutSutra || FAMOUS_SHORT_QUOTES.includes(piece)
}

// The longest runs of the user's words that occur in the sutra, one per chapter.
function quotedIn(text) {
  const words = han(text)
  const aboutSutra = ABOUT_THE_SUTRA.test(text)
  for (let length = Math.min(words.length, LONGEST_LOOKED_FOR); length >= SHORTEST_LOOKED_FOR; length--) {
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

// Asked by chapter: 第十四分, 第 14 分, 金剛經第十四章, 金剛經十四品, 離相寂滅分.
// A number needs 第 or 金剛經 right before it: 哪一分 is "which chapter", 十分
// 感動 is "very", 考了二十分 is a score. Without a word about the sutra, a 第N分
// must also be asked about (第十四分在講什麼, 解釋第十四分, a message that is only
// 第十四分?) or compared (第十四分跟第十五分差在哪), so 拿到第一分, 第二分的時候
// and 第一分館跟第二分館 are not chapters.
const CHAPTER_REF =
  /(第|金剛經的?)\s*([一二三四五六七八九十廿卅]{1,3}|\d{1,2})\s*(分|章|品)(?![鐘鍾之店局隊行院處區數館公校部會享社所組機線身半量卷點期])/g
const ASKS_ABOUT_IT =
  /^\s*(在講|講什麼|講啥|講的|在說|說什麼|說啥|說的|是什麼|是啥|是在講|是在說|的意思|的內容|的重點|的原文|原文|可以講|可以解釋|我看不懂|看不懂|怎麼解釋|[？?])/
const ASKING_FIRST = /(解釋|說明|講講|講一下|介紹|問|聊聊|想知道|請教)(一下)?\s*$/
const ONLY_A_CHAPTER = /^\s*(那|請問|想問|我想問|問一下|請問一下|欸|所以)?\s*第\s*\S{1,3}\s*分\s*[？?嗎呢]?\s*$/
const COMPARING = /差在哪|差別|有什麼不同|不一樣|比較/
const DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

function chapterNumber(written) {
  if (/^\d+$/.test(written)) return Number(written)
  const parts = written.replace('廿', '二十').replace('卅', '三十').split('十')
  if (parts.length === 1) return DIGITS[parts[0]] ?? NaN
  if (parts.length > 2) return NaN
  const [tens, ones] = parts
  return (tens ? DIGITS[tens] ?? NaN : 1) * 10 + (ones ? DIGITS[ones] ?? NaN : 0)
}

function byChapterName(text) {
  const plain = text.replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10))
  const aboutSutra = ABOUT_THE_SUTRA.test(plain)
  const refs = [...plain.matchAll(CHAPTER_REF)]
  const comparesTwo = refs.filter(({ 3: unit }) => unit === '分').length >= 2 && COMPARING.test(plain)
  const isAChapter = ({ 0: all, 3: unit, index }) =>
    aboutSutra ||
    (unit === '分' &&
      (ASKS_ABOUT_IT.test(plain.slice(index + all.length)) ||
        ASKING_FIRST.test(plain.slice(Math.max(0, index - 8), index)) ||
        ONLY_A_CHAPTER.test(plain) ||
        comparesTwo))
  const byNumber = refs
    .filter(isAChapter)
    .map(({ 2: written }) => CHAPTERS[chapterNumber(written) - 1])
    .filter(Boolean)
  // 離相寂滅分, 離相寂滅那一分, 離相寂滅在講什麼; not 依法出生登記 or 無法可得到他的心.
  const byTitle = CHAPTERS.filter((c) => {
    const name = c.title.replace(/分第.+$/, '')
    const at = plain.indexOf(name)
    if (at < 0) return false
    const after = plain.slice(at + name.length)
    return /^(分|那一分|這一分)/.test(after) || aboutSutra || ASKS_ABOUT_IT.test(after)
  })
  return [...byNumber, ...byTitle].map((chapter) => ({ chapter, why: `他可能在問〈${chapter.title}〉` }))
}

// Asked by topic. Names and terms only the sutra uses count on their own; a
// word that is also everyday talk (忍辱負重, 去廟裡布施, 五眼聯盟, 無我的境界)
// counts only next to a word about the sutra. 無相 is not 無相界, this bot.
const TOPICS = [
  { words: /須菩提.{0,6}(哭|流淚|涕淚|悲泣)/, chapters: [14], alone: true },
  {
    words: /須菩提(是誰|是什麼|是哪|是佛的)|誰是須菩提|須菩提.{0,4}問|叫須菩提/,
    chapters: [2],
    alone: true,
    note: '須菩提是佛的弟子，經裡向佛提問的人，第一次開口在這一分',
  },
  { words: /燃燈佛|然燈佛|授記|受記(?!者)/, chapters: [10, 17], alone: true },
  { words: /歌利王/, chapters: [14], alone: true },
  {
    words: /四句偈/,
    chapters: [26, 32],
    alone: true,
    note: '經裡好幾分都說「乃至四句偈等」，沒有指明是哪四句；一般常舉的是下面兩首偈，兩首在經裡各只出現一次',
  },
  { words: /一合相/, chapters: [30], alone: true },
  { words: /筏喻/, chapters: [6], alone: true },
  { words: /六如/, chapters: [32], alone: true },
  { words: /無為法/, chapters: [7], alone: true },
  { words: /無所住(是什麼|是啥|的意思|是指|在講|怎麼理解)/, chapters: [10, 4], alone: true },
  { words: /無所住/, chapters: [10, 4] },
  { words: /(什麼是|何謂)五眼(?!聯盟)|五眼(是什麼|指的是|在講)/, chapters: [18], alone: true },
  { words: /五眼(?!聯盟)/, chapters: [18] },
  { words: /忍辱/, chapters: [14] },
  { words: /筏/, chapters: [6] },
  { words: /四相|我相人相|眾生相|壽者相/, chapters: [3] },
  { words: /布施/, chapters: [4] },
  { words: /微塵/, chapters: [30, 13] },
  { words: /恆河沙|恒河沙/, chapters: [11] },
  { words: /無我/, chapters: [17] },
  { words: /無相(?!界)/, chapters: [5] },
  { words: /開頭|第一段|第一句/, chapters: [1] },
  { words: /結尾|最後一段|最後那段|最後一句|最後一分/, chapters: [32] },
  { words: /經名|經的名字|為什麼叫(做)?金剛|叫做金剛/, chapters: [13] },
]

function byTopic(text) {
  const aboutSutra = ABOUT_THE_SUTRA.test(text)
  return TOPICS.filter(({ words, alone }) => words.test(text) && (alone || aboutSutra)).flatMap(({ words, chapters, note }) =>
    chapters.map((n) => ({
      chapter: CHAPTERS[n - 1],
      why: `他提到的「${text.match(words)[0]}」${note ? `（${note}）` : ''}跟〈${CHAPTERS[n - 1].title}〉有關`,
    })),
  )
}

// 這句出自哪裡, 什麼意思, 看不懂: asking about a line the bot just quoted, such
// as today's line. It has to be plainly about that line, so 這段時間好累 and
// 我不懂我媽為什麼這樣 are not. Only quotes of six characters or more that are
// in the sutra count, so the user's own words in quotes (「只能這樣」) do not.
const POINTS_AT_THE_LINE =
  /這句|這一句|剛剛那句|剛才那句|你說的那句|你引的那句|這段經文|那段經文|這兩句|^\s*(出處|原文|出自哪)|哪一分(?!鐘)|第幾分(?!鐘)/
const ONLY_ASKS_WHAT_IT_MEANS =
  /^(喔|蛤|嗯+|欸|那|所以|請問|有點|可是)?\s*我?(還是)?(這段話|那段話|這段|這個|這|那)?(是)?(什麼意思|啥意思|看不懂|看不太懂|不懂|聽不懂|不太懂|怎麼解釋|在講什麼|在說什麼|可以解釋一下嗎|能講白話一點嗎|從哪裡來的|哪裡來的)[嗎呢啊耶欸喔？?。!！~\s]*$/

// 我老闆那段話到底什麼意思 and 他說的這句話 are someone else's words; 這句出自哪
// 裡？我媽也常說 is not.
const SOMEONE_ELSES_LINE =
  /(他|她|老闆|主管|同事|朋友|我媽|我爸|媽媽|爸爸|老師|男友|女友|男朋友|女朋友|老公|老婆|家人|別人|對方)(說的|講的|的)?(這句|那句|這段|那段)/

function referredBack(text, lastReply) {
  if (!lastReply || SOMEONE_ELSES_LINE.test(text)) return []
  if (!(POINTS_AT_THE_LINE.test(text) || ONLY_ASKS_WHAT_IT_MEANS.test(text.trim()))) return []
  return [...lastReply.matchAll(/「([^」]+)」/g)]
    .map(([, quote]) => han(quote))
    .filter((words) => words.length >= 6)
    .flatMap((words) => CHAPTERS.filter((_, i) => CHAPTER_HAN[i].includes(words)).slice(0, 1))
    .map((chapter) => ({ chapter, why: `他可能在問你剛剛引的那句，那句出自〈${chapter.title}〉` }))
}

/**
 * The chapters the model should read before answering this message: the ones
 * it quotes or names, or the one a line the bot just quoted is from; failing
 * those, the ones its topic is in. A topic adds nothing to a quote: 應無所住而生
 * 其心 is in the tenth chapter only, and handing over the fourth as well (it has
 * 應無所住 too) invites "this line appears twice".
 */
export function passagesFor(userText, recentTurns = []) {
  const last = recentTurns.at(-1)
  const lastReply = last?.role === 'assistant' ? last.content : ''
  const pointed = [...quotedIn(userText), ...byChapterName(userText), ...referredBack(userText, lastReply)]
  const seen = new Set()
  return (pointed.length ? pointed : byTopic(userText))
    .filter(({ chapter }) => !seen.has(chapter.title) && seen.add(chapter.title))
    .slice(0, MOST_CHAPTERS)
}

// 每日一句: on a Taipei day everyone gets the same line, going through the
// sutra in order, so pressing again is never a fresh draw (that would be
// 抽籤). Each line is the text word for word, with its chapter. Lines that read
// as a rebuke when shown alone are left out (是人行邪道, and the two that call
// the reader 凡夫), and so is a second line on giving in a row.
export const DAILY_LINES = [
  ['飯食訖，收衣缽，洗足已，敷座而坐。', 1],
  ['應云何住？云何降伏其心？', 2],
  ['菩薩於法，應無所住，行於布施。', 4],
  ['凡所有相，皆是虛妄。若見諸相非相，即見如來。', 5],
  ['知我說法，如筏喻者，法尚應捨，何況非法。', 6],
  ['一切賢聖，皆以無為法而有差別。', 7],
  ['所謂佛法者，即非佛法。', 8],
  ['莊嚴佛土者，即非莊嚴，是名莊嚴。', 10],
  ['應無所住而生其心。', 10],
  ['如來說：世界，非世界，是名世界。', 13],
  ['信心清淨，則生實相。', 14],
  ['離一切諸相，即名諸佛。', 14],
  ['若心有住，即為非住。', 14],
  ['若菩薩心不住法而行布施，如人有目，日光明照，見種種色。', 14],
  ['如來者，即諸法如義。', 17],
  ['一切法皆是佛法。', 17],
  ['過去心不可得，現在心不可得，未來心不可得。', 18],
  ['諸心皆為非心，是名為心。', 18],
  ['說法者，無法可說，是名說法。', 21],
  ['是法平等，無有高下。', 23],
  ['以無我、無人、無眾生、無壽者，修一切善法。', 23],
  ['於法不說斷滅相。', 27],
  ['菩薩所作福德，不應貪著。', 28],
  ['如來者，無所從來，亦無所去，故名如來。', 29],
  ['於一切法，應如是知，如是見，如是信解，不生法相。', 31],
  ['不取於相，如如不動。', 32],
  ['一切有為法，如夢幻泡影，如露亦如電，應作如是觀。', 32],
]

const TAIPEI_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000

/** The line at a place in DAILY_LINES; past the last one it starts again. */
export function lineAt(index) {
  const at = ((index % DAILY_LINES.length) + DAILY_LINES.length) % DAILY_LINES.length
  const [line, chapterNumber] = DAILY_LINES[at]
  return { index: at, line, chapter: CHAPTERS[chapterNumber - 1] }
}

export function todaysLine(now = Date.now()) {
  const at = Number.isFinite(now) ? now : Date.now()
  return lineAt(Math.floor((at + TAIPEI_OFFSET_MS) / DAY_MS))
}

// The day's line says what it is; the ones 再給一句 brings come bare.
export function lineReply({ line, chapter }, { first = false } = {}) {
  return first
    ? `每日一句\n\n「${line}」\n——〈${chapter.title}〉\n\n不用急著懂它。這句讓你想到什麼，或今天有哪個念頭一直回來，都可以跟我說`
    : `「${line}」\n——〈${chapter.title}〉\n\n這句讓你想到什麼，都可以跟我說`
}

export function todaysLineReply(now = Date.now()) {
  return lineReply(todaysLine(now), { first: true })
}

// 多了解這一段 first shows the whole chapter as it reads, so the passage never
// comes from the model: asked to retell it, the model mixed up who said what
// in 4 of 8 tries (2026-11-23). Then the model explains it. The line goes into
// the question as a quote, so the lookup above hands the model the chapter too.
export function passageOf({ chapter }) {
  return `〈${chapter.title}〉原文：\n\n${chapter.text}`
}

export function askAboutLine({ line, chapter }) {
  return `想多了解這一句：「${line}」（${chapter.title}）。整段原文我看過了，不用重講經文內容，用白話講重點就好：這段在說什麼，這句在裡面是什麼意思？`
}

export function passageNote(passages) {
  return (
    '（內部參考，不要念給他聽：下面是程式從他的話猜出來、可能用得上的經文，不一定是他要問的。' +
    '他在問經文的話，講出處、上下文時以這段原文為準，不要憑印象；加引號就逐字照抄原文，白話翻譯不要放進引號裡。' +
    '他沒在問經文的話，就當沒看到，不要因為這段把話題帶到金剛經。）\n' +
    passages.map(({ chapter, why }) => `${why}。這一分的原文：\n${chapter.text}`).join('\n\n')
  )
}
