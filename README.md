# Animitta 無相界

A LINE Bot for free-form conversation through a Diamond Sutra (金剛經) lens. It lets people chat naturally first — venting, wondering, asking practical questions, or seeking Buddhist insight — and brings scripture in only when it helps.

> 凡所有相，皆是虛妄；凡所有光，皆入視界。

*Animitta (अनिमित्त)* — Sanskrit for "signless, without marks." In the Diamond Sutra, forms are not denied, but they are not fixed. This bot uses that spirit as background: a place to speak freely, loosen what is being held too tightly, and sometimes see through a thought that felt solid.

## What It Does

**無相界** is a LINE chatbot that:

- Creates a low-pressure place to chat, vent, or ask for perspective
- Answers life questions with Diamond Sutra wisdom when the conversation calls for it
- Gives practical advice on management, communication, and decision-making
- Explains Buddhist concepts in plain Taiwanese Mandarin
- Provides emotional support when needed without forcing everything into therapy mode or scripture mode
- Remembers conversation context with a sliding window + LLM-powered summary compression

## Architecture

```
LINE App → Lambda Function URL → Lambda (Node.js 22.x) → OpenAI / Anthropic
                                              ↕
                                        DynamoDB (memory)
```

- **Lambda**: Thin handler → chat service → pluggable LLM provider
- **DynamoDB**: Conversation turns (sliding window) + a compressed summary per user
- **CDK**: Infrastructure as Code, one-command deploy
- **Dual LLM**: Switch between OpenAI and Anthropic via env var

## Features

- LINE webhook signature verification (HMAC-SHA256); every event in a webhook is handled
- Rich Menu with 3 buttons: 隨意聊聊 (casual chat), 清除記憶 (clear memory), 關於 (about)
- 今天的一句 (today's line): one line of the sutra, word for word with its chapter, the same for everyone on a Taipei day and in the sutra's order (27 lines; those that read as a rebuke when shown alone are left out), so pressing again is never a fresh draw. It is remembered like the casual-chat opener. The handler answers the postback `action=daily_line` and the typed `@今天的一句`; the rich menu has no button for it yet
- The Diamond Sutra is read from its text, not from the model's memory: `lambda/diamond-sutra.json` holds the whole sutra (鳩摩羅什譯, 32 chapters, from 維基文庫; that page calls itself 江味農校定本 but follows the circulated text in about 60 places, so the edition is still to be confirmed by someone who recites the sutra). When a message quotes five or more characters of it (four for its best-known short phrases such as 法尚應捨), names a chapter (第十四分在講什麼, 離相寂滅分), asks about a topic (四句偈, or 忍辱 next to a word about the sutra), or asks about a line the bot just quoted (這句出自哪裡), that chapter (at most two) goes into the prompt. Everyday words the sutra also has (不可思議, 全世界所有, 拿到第一分) count only next to a word about the sutra, and the note tells the model the chapter is the program's guess, to use only if the person is asking about the sutra. The whole text is not put in the prompt: measured on 2026-11-22, that answered worse at twice the input. The library lines in the prompt are tested to be the text word for word
- Crisis: the prompt gives 1925 and 1995 (both 24-hour) first. Both can be called at any hour, but neither always picks up, so the bot says to try the other. When the AI service fails on a message that talks of ending a life, the apology still gives them with 119/110. Since that only happens in an outage, the check leans toward hearing it: a phrase counts unless that very occurrence is a known everyday use (笑到想死, 想死你了, 跳樓大拍賣, 規劃自己), and nothing is deleted from the message before looking. News, quoting someone else and 物價高根本活不下去 therefore also get the numbers in an outage; lines that could go either way (想消失, 活著沒意義) are left to the model. The prompt itself treats 累到想死 and the like as everyday talk and asks when it cannot tell. Before deploying a prompt change, run `node scripts/check-crisis-replies.mjs` (real model, about US$0.01 a reply)
- Someone low for a long while may be told once of real people to talk to: community mental health centres and health bureaus, and 衛福部's free counselling for 15–45-year-olds, which drops out of the prompt by itself on 2027-01-01 because the program is announced only to the end of 2026
- Typing indicator while the LLM writes the reply
- Stickers are answered: LINE's sticker keywords (and the text on message stickers) go to the model
- Voice messages are transcribed by Amazon Transcribe (`zh-TW`) and answered like typed text. The recording and transcript sit in a private S3 bucket only while the job runs and are deleted right after. A job that runs past the 40-second deadline writes its transcript after that cleanup, which the bucket's one-day expiry rule removes (S3 may take up to about two days). Amazon may also keep content it processed to improve its AI services unless the account opts out through an AWS Organizations AI services opt-out policy, so before every recording the function reads the account's effective policy: unless it says `optOut` for Transcribe (or by default), nothing is sent to Amazon, the user is asked to type, no minutes are used, and the failure alarm goes off with "voice paused" in the log. Moving between AWS organizations or accounts therefore pauses voice until the opt-out applies again, and it resumes by itself Each user gets `VOICE_MINUTES_PER_MONTH` (30) minutes a month, and all users together `VOICE_MINUTES_ALL_USERS_PER_MONTH` (1,500, about US$9 of Transcribe), on Taipei time. A message over 3 minutes is turned away before anything is paid for (3.5 minutes measured about 20 seconds to transcribe). When a message fails, the user gets back the minutes they got no answer for, while everyone's count keeps what Amazon may already have billed once a job was asked for, so failures cannot push the bill past the total. Once everyone's minutes are used up, voice pauses for all users until the 1st and the `animitta-voice-limit-reached` alarm emails `ALERT_EMAIL`. Expect about 10–25 seconds before the reply, with the typing animation up meanwhile
- Photos, videos, files, locations and audio links from outside LINE get a short "type or send voice instead" reply, which is remembered
- Conversation memory: the last turns, plus an LLM-compressed summary for long-term context. After `SESSION_IDLE_HOURS` of silence a new session starts and the previous one comes back as background
- Retention: everything remembered about someone is gone `CONVERSATION_TTL_DAYS` (90) days after their last message. Each turn expires that long after it was said, the summary that long after the latest exchange. 關於 quotes the number
- Alerts: failed replies email `ALERT_EMAIL`; reminders go out before `ANTHROPIC_KEY_EXPIRES_ON`

## Quick Start

### Prerequisites

- Node.js 22+
- AWS CLI configured with appropriate permissions
- LINE Messaging API channel (Channel Access Token + Channel Secret)
- OpenAI API key (and/or Anthropic API key)
- The AWS account opted out of AI service improvement, through an AWS Organizations AI services opt-out policy. 關於 tells users a voice recording is deleted once transcribed, which holds only then; without it voice stays paused. Check with `aws organizations describe-effective-policy --policy-type AISERVICES_OPT_OUT_POLICY`, which should show `optOut`

### Setup

```bash
# Clone and install
git clone https://github.com/ceparadise168/animitta.git
cd animitta
npm install

# Configure
cp .env.example .env
# Edit .env with your API keys

# Deploy
npx cdk bootstrap  # First time only
npx cdk deploy --app "npx ts-node --prefer-ts-exts cdk/bin/app.ts"

# Set up Rich Menu
node scripts/setup-richmenu.mjs

# Copy the WebhookUrl from CDK output → LINE Developers Console → Webhook URL
```

### Environment Variables

See `.env.example` for all available configuration options.

Key variables:
- `LLM_PROVIDER`: `openai` or `anthropic`
- `CHAT_MODEL_OPENAI`: Model for conversation (e.g., `gpt-4.1-mini`)
- `MAX_RECENT_TURNS`: Number of recent conversation turns to keep (default: 5)
- `CONVERSATION_TTL_DAYS`: Days without a message after which everything remembered is deleted (default: 90). 關於 quotes it to users
- `VOICE_MINUTES_PER_MONTH`: Voice minutes each user may send a month (default: 30). 關於 quotes it to users
- `VOICE_MINUTES_ALL_USERS_PER_MONTH`: Voice minutes all users together may send a month (default: 1500), which caps the Transcribe bill

## Project Structure

```
animitta/
├── cdk/                    # AWS CDK infrastructure
│   ├── bin/app.ts
│   └── lib/animitta-stack.ts
├── lambda/
│   ├── index.mjs           # Lambda handler (routing)
│   ├── line.mjs            # LINE API helpers
│   ├── prompt.mjs          # System prompt + scripture library
│   ├── commands.mjs        # Rich Menu command handlers
│   ├── services/
│   │   ├── chat.mjs        # Chat orchestration
│   │   └── memory.mjs      # DynamoDB conversation memory
│   └── providers/
│       ├── base.mjs        # LLM provider interface
│       ├── openai.mjs      # OpenAI implementation
│       └── anthropic.mjs   # Anthropic implementation
├── test/                   # Jest test suite
├── scripts/
│   └── setup-richmenu.mjs  # One-time Rich Menu setup
└── docs/                   # Design specs and plans
```

## Customization

### Changing the Persona

Edit `lambda/prompt.mjs` — the `SYSTEM_PROMPT` defines the bot's personality, conversation strategy, and scripture library. The `FEW_SHOT_DEMOS` section shows example conversations that calibrate the bot's tone.

### Adding Scripture

Add quotes to the `<經文庫>` section in `prompt.mjs`, organized by theme. The bot selects relevant quotes based on conversation context.

### Switching LLM Provider

Set `LLM_PROVIDER=anthropic` in `.env` and provide `ANTHROPIC_API_KEY`.

## Testing

```bash
npm test
```

## License

MIT
