// Exits 1 when any summary does not read as a record.
//
// Run:  node scripts/check-summary-records.mjs [runs per scenario, default 5]
//       Uses .env ANTHROPIC_API_KEY and SUMMARY_MODEL_ANTHROPIC.
import 'dotenv/config'
import { AnthropicProvider } from '../lambda/providers/anthropic.mjs'

const RUNS = Number(process.argv[2] || 5)

const summary =
  '使用者是一名軟體工程師，常提到工作壓力與加班，主管下班後仍會交辦事情，使用者很難拒絕。最近睡不好，半夜常醒。' +
  '使用者對《金剛經》有興趣，問過「應無所住而生其心」的意思，bot 用日常例子說明「不執著」不等於「不在乎」。使用者有慢跑習慣，但最近因加班減少。'
const turn = (user, assistant) => [
  { role: 'user', content: user },
  { role: 'assistant', content: assistant },
]
const endsWithQuestion = turn(
  '今天又加班到快十點，一直在想是不是我太在意別人怎麼看我了。',
  '辛苦了。你說事情做完了卻還是覺得不夠好，像心裡有一把尺一直在量自己。今晚要不要先試試，睡前把明天的事寫下來，寫完就交給明天的自己？'
)
const endsWithStatement = turn(
  '今天又加班到快十點，一直在想是不是我太在意別人怎麼看我了。',
  '辛苦了。你說事情做完了卻還是覺得不夠好，像心裡有一把尺一直在量自己。先好好休息，明天再說。'
)
const fiveTurns = [
  ...endsWithQuestion,
  ...turn('我試了寫下來，好像有比較好睡一點，但早上一醒來又開始焦慮。', '能睡得好一點就很不容易了。早上一醒來就焦慮，像是念頭比人先起床。可以先看著它來，知道「喔，焦慮來了」，再慢慢做下一件事。'),
  ...turn('主管今天又在群組裡點名我，說進度太慢，我覺得很丟臉。', '被當眾點名真的很難受。那一刻的丟臉是真的，但它說的是這件事的進度，不是你整個人。要不要先分開看，哪些是你能做的，哪些不在你手上？'),
  ...turn('我能做的大概就是把卡住的地方講清楚，但我怕講了會被說是在找藉口。', '把卡住的地方講清楚，本身就是在推進事情。你可以只說事實：卡在哪、需要什麼、預計什麼時候。說完了，對方怎麼想就交給對方。'),
  ...turn('好，我明天試試看。謝謝你，跟你聊完好像沒那麼悶了。', '不客氣，聽到你沒那麼悶了，我也替你鬆了一口氣。明天不管結果怎樣，你願意去試，就已經很好了。'),
]
const allScenarios = [
  ['summary + turn ending in a question', summary, endsWithQuestion],
  ['summary + turn ending in a statement', summary, endsWithStatement],
  ['no summary + turn ending in a question', null, endsWithQuestion],
  ['summary + five turns', summary, fiveTurns],
]

const continues = (text) => /(^|\n)\s*(User|Assistant|使用者|無相界)\s*[:：]|\[(使用者|無相界)\]/.test(text)
const opensWithUser = (text) => /使用者|用戶/.test(text.slice(0, 40))
const addressesUserInFirstSentence = (text) => /^[^。]*你/.test(text)
const looksLikeRecord = (text) => opensWithUser(text) && !addressesUserInFirstSentence(text) && !continues(text)

const provider = new AnthropicProvider({ backup: null })
let records = 0
let total = 0
for (const [label, existing, turns] of allScenarios) {
  let scenarioRecords = 0
  for (let i = 0; i < RUNS; i++) {
    total++
    let out
    try {
      out = await provider.summarize(existing, turns)
    } catch (err) {
      console.log(`  [FAIL] ${label} #${i + 1}: ${err.message}`)
      continue
    }
    if (looksLikeRecord(out)) {
      scenarioRecords++
      continue
    }
    const wrote = continues(out) ? ', wrote new turns' : ''
    console.log(`  [FAIL] ${label} #${i + 1}${wrote}: ${[...out.replace(/\s+/g, ' ')].slice(0, 40).join('')}`)
  }
  records += scenarioRecords
  console.log(`${label}: ${scenarioRecords}/${RUNS} read as a record`)
}
console.log(`\n${records}/${total} read as a record`)
process.exit(records === total ? 0 : 1)
