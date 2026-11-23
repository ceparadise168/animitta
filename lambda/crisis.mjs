// When the bot breaks while someone says they want to end their life, the
// apology still gives numbers they can call at any hour.
//
// The owner's rule is that the hotlines must not come out for casual talk
// (觸發門檻不要隨意觸發; 2026-11-23: 再緊一點，不要隨意亂吐專線). So a word
// about death counts only as the person's own: news, films, someone else's
// words, a question about what Buddhism says, prices or a dying plant do not.
// Saying it plainly always counts (想自殺, 想燒炭, 我也想死), whatever else the
// message holds.
//
// Each phrase carries its own narrow exceptions, checked at that very spot.
// Nothing is deleted from the message before looking: deleting once hid
// 我覺得想死, 我有傷害自己的念頭 and 我媽死了 想死 (review, 2026-11-23). Lines
// that could go either way (想消失, 活著沒意義, 想走了, 生無可戀) are left to
// the model, which can ask.

// 累到想死, 痛到不想活, 熱死了想死: "very", unless the person says it is no joke.
const SO_MUCH =
  '(?<!(笑|累|熱|冷|餓|睏|忙|無聊|飽|撐|罵|難|尷尬|丟臉|辣|氣|煩|吵|擠|悶|醜|痛)(到|得))' +
  '(?<!(丟臉|熱|累|笑|冷|餓|忙|煩|氣|吵|尷尬|無聊|睏)死了[，,、\\s]*)'
const MEANS_IT = /不是開玩笑|沒在開玩笑|我是認真的|說真的/

// 新聞說有人燒炭, 電視劇女主角割腕, 佛教怎麼看自殺: talk about it, not their own.
const NOT_THEIR_OWN =
  '(?<!(新聞|報導|電影|影集|劇|主角|小說|遊戲|明星|藝人|佛教|宗教|佛法|金剛經|佛陀|基督教|聖經|怎麼看).{0,10})'
// 我同學說他想死: someone else's.
const NOT_SOMEONE_ELSE = '(?<![你妳他她])'

const DECEASED = '(爺爺|奶奶|阿公|阿嬤|外公|外婆|爸爸|媽媽|爸|媽|朋友|狗|貓|寵物|毛小孩)'

const phrases = (soMuch) => [
  // 想死, 想要死, 想去死; not 你想死喔, 他想死, 想死你了, 想死心, 想死背, 想死去的
  // 爺爺, 死海, or a bucket list (想死前至少去一次冰島)
  `${NOT_SOMEONE_ELSE}${soMuch}想要?去?死(?!心|背|板|馬|海|的心|你|妳|人了|我了|他了|她了|喔你|嗎你|(去|掉)的(那隻|那位|那個)?${DECEASED}|前(至少|要先|一定要|想去|要去))`,
  '心痛(到|得)(想死|不想活)', '我去死(?!海)', '死一死',
  // 不想活; not 不想活動, 不想活成我爸那樣, 不想活在別人的期待裡, 他不想活
  `${NOT_SOMEONE_ELSE}${soMuch}不想再?活(?!動|成|潑|著?的(樣子|人)|在(別人|他人|爸媽|父母|大家|社會|人家)的)`,
  '(?<!(物價|油價|房價|薪水|薪資|小資族|股票|股市|植物|盆栽|魚|牠).{0,8})活不下去', '想離開這個?世界',
  // said plainly, these count even next to news or a question
  '想要?自殺', '(打算|準備|決定)(要)?自殺', '我自殺', '想要?輕生', '想(要)?(燒炭|上吊|割腕)', '(要|準備)(燒炭|上吊)', '買了炭',
  `${NOT_THEIR_OWN}自殺(?!式|關卡|小隊|防治|率)`, `${NOT_THEIR_OWN}輕生(?!的人|率|事件|新聞|案)`, '尋死(?!覓活)',
  '結束生命', '結束(自己的|我的)(生命|人生)', '結束這一切', '想要?結束自己(?!的)',
  '了結自己', '自我了斷', '自我了結', '了斷自己', '一死了之', '想了斷(?![這那]|關係|感情|孽緣)',
  `${NOT_THEIR_OWN}(?<!(辭職|辭掉|離職|不幹).{0,8})一了百了(?!.{0,8}(辭職|辭掉|離職))`,
  `${NOT_THEIR_OWN}割腕`, '(又|我)割腕', '(?<![規策計籌企區])(割|劃)(了|傷)?自己', '(?<![規策計籌企區好很會])(割|劃)手(?!機)', '我又(割|劃)了',
  `${NOT_THEIR_OWN}(?<!烤肉.{0,6})燒炭(?!的新聞)`, `${NOT_THEIR_OWN}上吊(?!眼|式)`,
  `${NOT_THEIR_OWN}(?<!(套牢|賠|虧|輸).{0,3})跳樓(?!(大)?(拍賣|價|特價|出清|甩賣|放送)|機)`,
  `(?<!(套牢|賠|虧|輸|爛|慘)(到|得)?)(想|要|去)跳樓`,
  `${soMuch}想去?(跳河|跳海|臥軌|喝農藥)`, '想跳下去(?!游|玩|看|撿|救)',
  '(想|要|準備|打算)要?從.{0,4}(頂樓|樓上|陽台|窗戶|橋上).{0,3}跳',
  '吞.{0,8}安眠藥', '安眠藥.{0,4}(全|都)?吞', '(吞|吃)了?(一?整|好幾|一堆|很多|大量|\\d+)(瓶|罐|盒|排|顆|包)?.{0,3}(安眠)?藥',
  '想吞藥', '吞藥自殺', '藥都囤好', '囤了很多藥',
  `(?<!(劇|遊戲|電影|這部|追).{0,4})自殘(?!式)`,
  `(?<!(熬夜|抽菸|喝酒|宵夜|不睡覺|久坐).{0,6})傷害自己(?!的(膝蓋|身體|眼睛|腳|手|皮膚|喉嚨))`,
  '(?<!(說|講).{0,2})死了算了', '死掉就好了', '(我|乾脆|不如|真想)(死掉|死了|去死)(算了|就好)',
  '不想再醒(來|過來)', '(?<!夢.{0,10})不想醒(來|過來)了', '(?<!夢.{0,10})(永遠|明天)?不要再?醒(來|過來)',
  '睡著就不要再?醒', '睡一覺就不要再?醒',
  '不想存在', '我(消失|不在)就好了', '我(不在|消失|死)了(以後|之後)?[，,、\\s]*大家', '我死掉的話.{0,4}大家',
  '(?<!(課|作業|練習|老師).{0,8})遺書',
  'wann?a ?die', 'want(ed)? ?to ?die', 'kill ?myself', 'suicid(?!e ?squad)', "(don'?t|do not) ?want ?to ?live",
]

const HEARS = new RegExp(phrases(SO_MUCH).join('|'), 'i')
const HEARS_WHEN_THEY_MEAN_IT = new RegExp(phrases('').join('|'), 'i')

export const CRISIS_FALLBACK_REPLY =
  '我這邊出了點問題，沒辦法好好回你，但你說的我有看到。\n\n' +
  '現在很難受的話，1925 安心專線、1995 生命線 24 小時都可以打，一支打不通就換另一支；有危險就直接打 119 或 110。身邊有人的話，也先找他陪你。'

export function talksOfEndingLife(text) {
  if (typeof text !== 'string') return false
  return (MEANS_IT.test(text) ? HEARS_WHEN_THEY_MEAN_IT : HEARS).test(text)
}
