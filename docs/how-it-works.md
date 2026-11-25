# How 無相界 works

無相界 (Animitta) is a LINE chatbot for free-form conversation through a Diamond Sutra (金剛經) lens. It lets people chat naturally first, whether venting, wondering, asking practical questions, or seeking Buddhist insight, and brings scripture in only when it helps.

The [README](../README.md) is the overview, in Traditional Chinese. This page is the reference for maintainers: what the bot does in each case, and how it is deployed and watched. It describes the code on `main`, so update a section in the same pull request that changes the code it describes.

## LINE

- LINE webhook signature verification (HMAC-SHA256); every event in a webhook is handled
- Rich Menu with 4 buttons, set up by `scripts/setup-richmenu.mjs`: 隨意聊聊 (casual chat), 每日一句 (a line a day), 清除記憶 (clear memory), 關於 (about)
- Typing indicator while the LLM writes the reply
- Stickers are answered: LINE's sticker keywords (and the text on message stickers) go to the model
- Photos, videos, files, locations and audio links from outside LINE get a short "type or send voice instead" reply, which is remembered

## 每日一句 (a line a day)

每日一句 (a line a day) shows one line of the sutra, word for word with its chapter, in the sutra's order (27 lines; those that read as a rebuke when shown alone are left out). The first press on a Taipei day shows that day's line, the same for everyone. Once the bot remembers showing it, pressing again reads on from the last line shown, so a press never repeats a line and is never a fresh draw. It is remembered like the casual-chat opener.

Under it, two Quick Reply buttons: 多了解這一段 sends the whole chapter as it reads, then the model's plain explanation (the passage never comes from the model, which mixed up who said what when it retold it). A chapter the bot remembers showing is not sent again, only the explanation. The question to the model carries the whole sentence a line was cut from, and asks for a short answer that keeps to the text; `node scripts/check-line-explanations.mjs` asks it about every line with the real model and fails when the median answer runs past the prompt's 220 characters. 再給一句 brings the next line in the sutra's order, again with both buttons. Buttons go only under these fixed lines, never under chat replies.

"Remembers" means the turns the bot still holds word for word: this session's, and the session before until it is folded into the summary. After 清除記憶, or once the line's turn is folded, the first press shows the day's line again.

The handler answers the postbacks `action=daily_line`, `action=daily_line_more&line=N` and `action=daily_line_next&line=N`, and the typed `@每日一句`. The menu's 每日一句 button sends `action=daily_line` and closes the menu.

## Sutra lookup

The Diamond Sutra is read from its text, not from the model's memory: `lambda/diamond-sutra.json` holds the whole sutra: 鳩摩羅什's translation in the circulated text most people recite (流通本, from 報佛恩網's 般若文海, book.bfnn.org/books/0040.htm), in 32 chapters with 昭明太子's titles. The lookup reads 即/則, 恒/恆, 暗/闇 and 繞/遶 as one character, so someone reciting another printing still finds the chapter.

When a message quotes five or more characters of it (four for its best-known short phrases such as 法尚應捨), names a chapter (第十四分在講什麼, 離相寂滅分), asks about a topic (四句偈, or 忍辱 next to a word about the sutra), or asks about a line the bot just quoted (這句出自哪裡), that chapter (at most two) goes into the prompt. Everyday words the sutra also has (不可思議, 全世界所有, 拿到第一分) count only next to a word about the sutra, and the note tells the model the chapter is the program's guess, to use only if the person is asking about the sutra.

The whole text is not put in the prompt: measured on 2026-11-22, that answered worse at twice the input. The library lines in the prompt are tested to be the text word for word.

## Crisis lines

The prompt gives 1925 and 1995 (both 24-hour) first. Both can be called at any hour, but neither always picks up, so the bot says to try the other. When the AI service fails on a message that talks of ending a life, the apology still gives them with 119/110.

The check in `lambda/crisis.mjs` counts a word about death only as the person's own, so the numbers do not come out for casual talk. News, films, someone else's words, a question about what Buddhism says, prices (物價高根本活不下去) and a dying plant do not count, and neither do everyday uses such as 笑到想死, 累到想死, 想死你了 and 跳樓大拍賣, unless the person says it is no joke (累到想死 我是認真的). Saying it plainly always counts (想自殺, 想燒炭, 我也想死), whatever else the message holds. Each phrase carries its own narrow exceptions, checked at that very spot, and nothing is deleted from the message before looking. Lines that could go either way (想消失, 活著沒意義, 想走了, 生無可戀) are left to the model, which can ask. The prompt itself treats 累到想死 and the like as everyday talk and asks when it cannot tell.

Before deploying a prompt change, run `node scripts/check-crisis-replies.mjs` (real model, about US$0.01 a reply).

Someone low for a long while may be told once of real people to talk to: community mental health centres and health bureaus, and 衛福部's free counselling for 15–45-year-olds, which drops out of the prompt by itself on 2027-01-01 because the program is announced only to the end of 2026.

## Voice messages

Voice messages are transcribed by Amazon Transcribe (`zh-TW`) and answered like typed text. The recording and transcript sit in a private S3 bucket only while the job runs and are deleted right after. A job that runs past the 40-second deadline writes its transcript after that cleanup, which the bucket's one-day expiry rule removes (S3 may take up to about two days).

Amazon may also keep content it processed to improve its AI services unless the account opts out through an AWS Organizations AI services opt-out policy, so before every recording the function reads the account's effective policy: unless it says `optOut` for Transcribe (or by default), nothing is sent to Amazon, the user is asked to type, no minutes are used, and the failure alarm goes off with "voice paused" in the log. Moving between AWS organizations or accounts therefore pauses voice until the opt-out applies again, and it resumes by itself.

Each user gets `VOICE_MINUTES_PER_MONTH` (30) minutes a month, and all users together `VOICE_MINUTES_ALL_USERS_PER_MONTH` (1,500, about US$9 of Transcribe), on Taipei time. A message over 3 minutes is turned away before anything is paid for (3.5 minutes measured about 20 seconds to transcribe). When a message fails, the user gets back the minutes they got no answer for, while everyone's count keeps what Amazon may already have billed once a job was asked for, so failures cannot push the bill past the total. Once everyone's minutes are used up, voice pauses for all users until the 1st and the `animitta-voice-limit-reached` alarm emails `ALERT_EMAIL`.

Expect about 10–25 seconds before the reply, with the typing animation up meanwhile.

## Memory and retention

Conversation memory holds the last turns, plus an LLM-compressed summary for long-term context. After `SESSION_IDLE_HOURS` of silence a new session starts and the previous one comes back as background.

A person's turns and summary are gone `CONVERSATION_TTL_DAYS` (30) days after their last message. Each turn expires that long after it was said, the summary that long after the latest exchange. 關於 quotes the number. The function's log group has the same retention, and a handler error is logged without the words that went unanswered. The voice minute counter is kept 40 days, so a month's quota holds.

## When Anthropic fails

A fast 5xx or 529, or a dropped connection, is tried once more; anything else except a rate limit (429) goes to the backup, the same Claude model on Amazon Bedrock (`BEDROCK_MODEL_ID`, a `jp.` profile that runs only in Tokyo and Osaka). One try at Anthropic gets at most 20 seconds, so a hung Anthropic still leaves the backup time before the 55-second deadline.

A reply from the backup logs `Provider fallback: <Anthropic's failure>`, which the `animitta-answered-by-backup` alarm counts, since the failure alarm no longer sees it. 關於 says the backup exists while it is configured. Errors name only the status and the documented error type, never the API's own text.

The backup is off unless `BEDROCK_MODEL_ID` is set (for example `jp.anthropic.claude-haiku-4-5-20251001-v1:0`). A limit Eric set himself in the Console never goes to the backup. It must be a `jp.` profile of the same model as `CHAT_MODEL_ANTHROPIC`, or synth fails, because 關於 tells users it is the same model, run in Japan. Before it can answer, someone with admin rights submits Anthropic's first-time-use form in the Bedrock console and sends one message in the playground, which also subscribes the account through AWS Marketplace; then the self-test shows `"bedrock":"ok"`.

## Self-test

```bash
aws lambda invoke --function-name animitta --payload '{"selfTest":true}' --cli-binary-format raw-in-base64-out out.json
```

It asks Anthropic and the backup a one-word question and checks a LINE signature with the real secret, then writes `{"anthropic":"ok","bedrock":"ok","signature":"ok"}` or the failure messages. Only a direct invoke runs it; requests through the webhook URL carry `requestContext` and never do.

## Alerts

Failed replies email `ALERT_EMAIL`; reminders go out before `ANTHROPIC_KEY_EXPIRES_ON`.

`animitta-alert-triage` reads the failure lines behind each alarm and emails `ALERT_EMAIL` (its own topic, confirmed once) the cause, what users saw, and the one step to take, once per cause in six hours. It keeps only status codes, documented error types, error class names and file:line of the bot's code, so nothing a user typed leaves the log. For a code error or a cause it cannot name, it also wakes a Claude Code routine (URL and token in SSM `/animitta/alert-routine/*`, at most once in six hours) with that summary and the commit that runs; the email links the session.

## Delivery

A PR runs `test` (required by a ruleset on main) and `deploy-scope`, which fails when cdk/ or ops/ changed, since a merge does not deploy those. A merge that changes lambda/ runs `deploy`, which lists the changed files on the run page and waits for Eric to approve the `production` environment; the AWS role it assumes trusts only jobs in that environment. It refuses when lambda/ on main has moved on, when cdk/ or ops/ differ from what `npm run deploy` last put up, or when the live code is not what the last deploy recorded (SSM `/animitta/deployed`). It saves the live package, uploads lambda/, runs the self-test (Anthropic or the backup must answer) and an unsigned webhook request, records the commit, and on any failure or cancellation puts the saved package back and emails.

Every `aws lambda` call anywhere in .github/ asks for one listed field or prints nothing: Lambda's answers carry the bot's keys and the Actions logs are public (`scripts/check-workflows.mjs`). The webhook URL is a `production` environment secret, so the logs mask it. The approval holds only while the Claude routine reaches GitHub through the Claude GitHub App, which has no deployments permission; a token saved with `/web-setup` is Eric's own and could approve.
