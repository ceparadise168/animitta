# prajna-gate 般若之門

A LINE Bot powered by Diamond Sutra (金剛經) wisdom. Acts as a wise mentor — blending ancient Buddhist scripture with practical life advice, management insight, and philosophical dialogue.

## What It Does

**無相界** is a LINE chatbot that:

- Answers life questions with Diamond Sutra wisdom
- Gives practical advice on management, communication, and decision-making
- Explains Buddhist concepts using everyday metaphors
- Provides emotional support when needed — without forcing everything into therapy mode
- Remembers conversation context with a sliding window + LLM-powered summary compression

## Architecture

```
LINE App → API Gateway (Function URL) → Lambda (Node.js 22.x) → OpenAI / Anthropic
                                              ↕
                                        DynamoDB (memory)
```

- **Lambda**: Thin handler → chat service → pluggable LLM provider
- **DynamoDB**: Conversation turns (sliding window) + compressed summaries + feedback
- **CDK**: Infrastructure as Code, one-command deploy
- **Dual LLM**: Switch between OpenAI and Anthropic via env var

## Features

- LINE webhook signature verification (HMAC-SHA256)
- Audio message transcription (Whisper API)
- Rich Menu with 3 buttons: casual chat, reset memory, feedback
- Quick Reply suggestion buttons (structured output from LLM)
- Typing indicator while LLM processes
- Binary feedback collection (👍 有收穫 / 👋 還好) with optional text follow-up
- Conversation memory: recent turns + LLM-compressed summary for long-term context

## Quick Start

### Prerequisites

- Node.js 22+
- AWS CLI configured with appropriate permissions
- LINE Messaging API channel (Channel Access Token + Channel Secret)
- OpenAI API key (and/or Anthropic API key)

### Setup

```bash
# Clone and install
git clone https://github.com/anthropics/prajna-gate.git
cd prajna-gate
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

## Project Structure

```
prajna-gate/
├── cdk/                    # AWS CDK infrastructure
│   ├── bin/app.ts
│   └── lib/prajna-gate-stack.ts
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

Set `LLM_PROVIDER=anthropic` in `.env` and provide `ANTHROPIC_API_KEY`. Audio transcription always uses OpenAI Whisper (Anthropic has no audio API).

## Testing

```bash
npm test
```

## License

MIT
