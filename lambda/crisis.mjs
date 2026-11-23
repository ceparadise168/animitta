// When the bot breaks while someone says they want to end their life, the
// apology still gives numbers they can call at any hour.
//
// This only runs when the AI service has failed, and missing a real one costs
// far more than adding the numbers to an everyday line, so it leans toward
// hearing it. A phrase counts unless that very occurrence is a known everyday
// use (笑到想死, 想死你了, 跳樓大拍賣, 規劃自己); nothing is deleted from the
// message before looking, because deleting once hid 我覺得想死, 我有傷害自己的
// 念頭 and 我媽死了 想死 (review, 2026-11-23). The owner's rule is that the
// hotlines must not come out for casual talk (觸發門檻不要隨意觸發); lines that
// could go either way (想消失, 活著沒意義, 想走了, 生無可戀) are left to the
// model, which can ask.

// 累到想死, 熱得不想活: "very", unless the person says it is no joke.
const SO_MUCH = '(?<!(笑|累|熱|冷|餓|睏|忙|無聊|飽|撐|罵|難|尷尬|丟臉|辣|氣|煩|吵|擠|悶|醜)(到|得))'
const MEANS_IT = /不是開玩笑|沒在開玩笑|我是認真的|說真的/

const DECEASED = '(爺爺|奶奶|阿公|阿嬤|外公|外婆|爸爸|媽媽|爸|媽|朋友|狗|貓|寵物|毛小孩)'

const phrases = (soMuch) => [
  // 想死, 想要死, 想去死; not 你想死喔, 想死你了, 想死心, 想死背, 想死去的爺爺, 死海
  `(?<![你妳])${soMuch}想要?去?死(?!心|背|板|馬|海|的心|你|妳|人了|我了|他了|她了|喔你|嗎你|(去|掉)的(那隻|那位|那個)?${DECEASED})`,
  '我去死(?!海)', '死一死',
  // 不想活; not 不想活動, 不想活成我爸那樣, 他不想活的樣子
  `${soMuch}不想再?活(?!動|成|潑|著?的(樣子|人))`,
  '活不下去', '想離開這個?世界',
  '自殺(?!式|關卡|小隊|防治|率)', '輕生', '尋死(?!覓活)',
  '結束生命', '結束(自己的|我的)(生命|人生)', '結束這一切', '想要?結束自己(?!的)',
  '了結自己', '自我了斷', '自我了結', '了斷自己', '一死了之', '想了斷(?![這那]|關係|感情|孽緣)', '一了百了',
  '割腕', '(?<![規策計籌企區])(割|劃)(了|傷)?自己', '(?<![規策計籌企區好很會])(割|劃)手(?!機)', '我又(割|劃)了',
  '(?<!烤肉.{0,6})燒炭', '上吊(?!眼|式)', '跳樓(?!(大)?(拍賣|價|特價|出清|甩賣|放送)|機)',
  `${soMuch}想去?(跳河|跳海|臥軌|喝農藥)`, '想跳下去(?!游|玩|看|撿|救)',
  '(想|要|準備|打算)要?從.{0,4}(頂樓|樓上|陽台|窗戶|橋上).{0,3}跳',
  '吞.{0,8}安眠藥', '安眠藥.{0,4}(全|都)?吞', '(吞|吃)了?(一?整|好幾|一堆|很多|大量|\\d+)(瓶|罐|盒|排|顆|包)?.{0,3}(安眠)?藥',
  '想吞藥', '吞藥自殺', '藥都囤好', '囤了很多藥', '自殘(?!式)',
  '傷害自己(?!的(膝蓋|身體健康|眼睛|腳|手|皮膚|喉嚨))',
  '死了算了', '死掉就好了', '(我|乾脆|不如|真想)(死掉|死了|去死)(算了|就好)',
  '不想再醒(來|過來)', '(?<!夢.{0,10})不想醒(來|過來)了', '(?<!夢.{0,10})(永遠|明天)?不要再?醒(來|過來)',
  '睡著就不要再?醒', '睡一覺就不要再?醒',
  '不想存在', '我(消失|不在)就好了', '我(不在|消失|死)了(以後|之後)?[，,、\\s]*大家', '我死掉的話.{0,4}大家', '遺書',
  'wann?a ?die', 'want(ed)? ?to ?die', 'kill ?myself', 'suicid', "(don'?t|do not) ?want ?to ?live",
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
