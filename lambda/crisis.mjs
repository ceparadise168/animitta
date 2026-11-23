// When the bot breaks while someone says they want to end their life, the
// apology still has to give them a number they can call at any hour. The
// owner's rule is that the hotlines must not come out for casual talk
// (觸發門檻不要隨意觸發), so everyday exaggeration is taken out first, then the
// words that say it plainly are looked for. Lines that could go either way
// (想消失, 活著沒意義, 想走了, 生無可戀) are left to the model when it answers.
const ENDING_LIFE = new RegExp(
  [
    '想要?去?死', '我去死', '死一死', '不想活', '不想再活', '活不下去', '想離開這個世界',
    '自殺', '輕生', '尋死', '結束(自己的|我的)?生命', '想要?結束自己(?!的)', '結束這一切', '了結自己', '自我了斷', '想了斷', '了斷自己', '一了百了',
    '割腕', '割手', '劃手', '割自己', '劃自己', '我又(割|劃)了', '燒炭', '上吊', '跳樓', '想去?跳河', '想跳下去',
    '從.{0,4}(頂樓|樓上|陽台|窗戶|橋上).{0,2}跳',
    '吞安眠藥', '想吞藥', '吞藥自殺', '(吞|吃)了(一?整|好幾)(瓶|罐|盒|排)', '藥都囤好', '自殘', '傷害自己',
    '死了算了', '死掉算了', '死了就好', '死掉就好',
    '不想再醒(來|過來)', '不想醒(來|過來)了', '不要再醒', '永遠不要醒來', '明天不要醒來', '睡著就不要再?醒', '睡一覺就不要再?醒',
    '不想存在', '消失就好了', '我(不在|消失|死)了?(以後|之後)?大家', '遺書',
    'wanttodie', 'killmyself', 'suicid', // spaces are taken out before matching
  ].join('|'),
  'i',
)

// 罵到想死, 尷尬到想死, 熱死了想死 and 累到不想活 are ways of saying "very",
// but 難過到想死 is not, so the hurt words keep the sentence in.
const HURT = /難過|痛苦|絕望|崩潰|憂鬱|傷心|孤單|寂寞|無助|自責|煎熬|心痛|心累/
// 「是真的，不是開玩笑」 means the exaggeration is not one.
const MEANS_IT = /是真的|不是開玩笑|沒在開玩笑|認真的/
const SO_MUCH_I_COULD_DIE = /([一-鿿]{1,4})((到|得)(想死|不想活)|死了[，,]?想死)/g
const EVERYDAY = new RegExp(
  [
    '想死(你|妳|他|她|你們|妳們)(了|啦|喔|囉|耶|欸)', '想死我了', '想死人了', '想死去的', '想死掉的', // missing someone
    '(你|妳)(是不是)?想死', '想死喔你', '想死的心都有', // a joking threat, an idiom
    '跳樓(大)?(拍賣|價|特價|出清)', '跳樓機', '(自殺|自殘|上吊)式', '自殺關卡', '尋死覓活', '自殺防治',
    '不想活在', '不想活成', '不想活得', '傷害自己的',
    '根本活不下去', '活不下去了?啦', '(物價|油價|房價|薪水|薪資|小資族).{0,8}活不下去',
    '(辭職|辭掉|離職|工作|分手).{0,8}一了百了', '一了百了.{0,8}(辭職|辭掉|離職|工作|分手)',
  ].join('|'),
  'g',
)

export const CRISIS_FALLBACK_REPLY =
  '我這邊出了點問題，沒辦法好好回你。但你說的我看到了。\n\n' +
  '現在很難受的話，1925 安心專線、1995 生命線 24 小時都可以打，一支打不通就換另一支。如果有立即的危險，直接打 119 或 110。'

export function talksOfEndingLife(text) {
  if (typeof text !== 'string') return false
  const plain = text
    .replace(/\s+/g, '')
    .replace(SO_MUCH_I_COULD_DIE, (all, before) => (HURT.test(before) || MEANS_IT.test(text) ? all : ''))
    .replace(EVERYDAY, '')
  return ENDING_LIFE.test(plain)
}
