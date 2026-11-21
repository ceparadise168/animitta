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
- Typing indicator while the LLM writes the reply
- Stickers are answered: LINE's sticker keywords (and the text on message stickers) go to the model
- Voice, photos, videos, files and locations get a short "I can only read text" reply, which is remembered
- Conversation memory: the last turns, plus an LLM-compressed summary for long-term context. After `SESSION_IDLE_HOURS` of silence a new session starts and the previous one comes back as background
- Retention: remembered turns expire `CONVERSATION_TTL_DAYS` (30) after they were said; the summary expires `SUMMARY_TTL_DAYS` (90) after the last message. 關於 tells users both numbers
- Alerts: failed replies email `ALERT_EMAIL`; reminders go out before `ANTHROPIC_KEY_EXPIRES_ON`

## Quick Start

### Prerequisites

- Node.js 22+
- AWS CLI configured with appropriate permissions
- LINE Messaging API channel (Channel Access Token + Channel Secret)
- OpenAI API key (and/or Anthropic API key)

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
- `CONVERSATION_TTL_DAYS` / `SUMMARY_TTL_DAYS`: How long turns and the summary are kept (defaults: 30 / 90)

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
