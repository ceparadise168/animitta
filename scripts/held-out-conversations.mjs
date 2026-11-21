// Held-out multi-turn conversations. They are NOT few-shot demo inputs: they test
// whether the bot generalises the varied-move behaviour instead of parroting a demo.
export const conversations = [
  {
    name: '1. 關係疏離 — 使用者回覆逐輪變短',
    probe: '會不會塌三段式 / 每輪拆解收尾 / 讀到對方變短有沒有降速、把方向交還',
    turns: [
      '最近跟身邊的人都有點疏遠',
      '不知道 就覺得能講的越來越少',
      '對啊',
      '可能我也沒有很想講',
      '孤單吧',
      '嗯',
    ],
  },
  {
    name: '2. 意義感低落 — 反覆繞「為了什麼」',
    probe: '會不會觸發低落形狀的軟性關心 / 經文有沒有報幕 / 會不會誤升成危機模式',
    turns: [
      '最近一直在想 這樣活著到底是為了什麼',
      '就每天上班 下班 一直重複',
      '不知道耶',
      '就是提不起勁',
    ],
  },
  {
    name: '3. 輕鬆閒聊 — 控制組',
    probe: '不該過度沉重 / 不該誤觸發軟性關心 / 跟得上輕鬆能量',
    turns: ['欸 今天天氣有夠好', '好想翹班出去走走', '哈哈對啊'],
  },
  {
    name: '4. 工作與錢卡住 — 失敗主題，held-out 措辭',
    probe: '會不會每輪拆解 / 「鬆動一個念頭」那一招有沒有出來',
    turns: [
      '覺得自己只是在為了賺錢而活',
      '工作其實沒有不喜歡 但也說不上喜歡',
      '就一種 反正得做的感覺',
      '對 卡住了',
    ],
  },
]
