# prajna-gate Design Spec

## Overview

Rewrite the existing Python LINE Bot Lambda (`lambda_handler`) as a Node.js project named `prajna-gate`, deployed via AWS CDK. The bot is "無相界" — a Diamond Sutra-inspired counselor for employees. The new stack runs alongside the old Lambda without touching it; once verified, the LINE webhook is manually switched to the new API Gateway endpoint.

## Goals

1. Rewrite in JavaScript (ES modules) with clean separation of concerns
2. Deploy as a new, independent AWS CDK stack (Lambda + API Gateway + DynamoDB)
3. Support switching between OpenAI and Anthropic as the LLM provider via adapter pattern
4. Implement real short-term conversational memory (sliding window + LLM summary compression)
5. Add LINE webhook signature verification (missing in the original)
6. Preserve all existing bot personality and prompt content (Diamond Sutra counselor)

## Non-Goals

- Modifying or deleting the existing `lambda_handler` Python Lambda
- Modifying the existing `LambdaSimpleProxy` API Gateway
- Modifying the existing `TheDiamondSutraConversationSummaries` DynamoDB table
- Building a web UI or admin dashboard

## Architecture

```
LINE App
  │
  ▼
API Gateway (HTTP API)
  │
  ▼
Lambda (Node.js 22.x)
  │
  ├─► line.mjs          Parse webhook, verify signature, reply
  ├─► chat.mjs          Assemble prompt + memory, call LLM
  ├─► memory.mjs        DynamoDB read/write, sliding window, summary trigger
  ├─► providers/
  │   ├─► openai.mjs    OpenAI Chat Completion + Whisper
  │   └─► anthropic.mjs Anthropic Messages API
  └─► prompt.mjs        System prompt + few-shot examples
  │
  ▼
DynamoDB (prajna-gate-conversations)
```

## Project Structure

```
prajna-gate/
├── cdk/
│   ├── bin/app.ts
│   └── lib/prajna-gate-stack.ts
├── lambda/
│   ├── index.mjs                # Lambda handler entry point
│   ├── line.mjs                 # LINE API helpers (verify, download, reply)
│   ├── prompt.mjs               # System prompt + few-shot examples
│   ├── services/
│   │   ├── chat.mjs             # Orchestrates prompt + memory + LLM call
│   │   └── memory.mjs           # DynamoDB conversation memory management
│   └── providers/
│       ├── base.mjs             # LLM provider interface
│       ├── openai.mjs           # OpenAI implementation
│       └── anthropic.mjs        # Anthropic implementation
├── .env.example
├── package.json
└── README.md
```

## Environment Variables

```env
# LLM Provider Selection
LLM_PROVIDER=openai              # "openai" | "anthropic"

# OpenAI
OPENAI_API_KEY=sk-xxx
CHAT_MODEL_OPENAI=gpt-4.1-mini
SUMMARY_MODEL_OPENAI=gpt-4.1-mini

# Anthropic
ANTHROPIC_API_KEY=sk-ant-xxx
CHAT_MODEL_ANTHROPIC=claude-haiku-4-5-20251001
SUMMARY_MODEL_ANTHROPIC=claude-haiku-4-5-20251001

# LINE
LINE_CHANNEL_ACCESS_TOKEN=xxx
LINE_CHANNEL_SECRET=xxx

# Memory
MEMORY_TABLE_NAME=prajna-gate-conversations
MAX_RECENT_TURNS=5
SUMMARY_THRESHOLD=3000           # character count to trigger summary compression
CONVERSATION_TTL_DAYS=30
```

## Component Details

### 1. Lambda Handler (`index.mjs`)

Thin entry point. Responsibilities:
- Parse the LINE webhook body
- Verify webhook signature using `LINE_CHANNEL_SECRET` + HMAC-SHA256
- Route to the appropriate handler based on message type (text, audio)
- Return 200 immediately (LINE requires fast response)

```
Event → Verify Signature → Parse Message → Route
  ├─ text  → chat.handleText(userId, replyToken, text)
  └─ audio → chat.handleAudio(userId, replyToken, messageId)
```

### 2. LINE Helpers (`line.mjs`)

- `verifySignature(body, signature, secret)` — HMAC-SHA256 verification
- `downloadContent(messageId)` — Download audio/image binary from LINE
- `replyMessage(replyToken, text)` — Send text reply via LINE Messaging API

All HTTP calls use native `fetch` (Node.js 22.x built-in). No `axios` or `node-fetch` dependency needed.

### 3. Chat Service (`services/chat.mjs`)

Orchestration layer:

```
handleText(userId, replyToken, userText):
  1. memory.getContext(userId)           → { summary, recentTurns }
  2. prompt.buildMessages(summary, recentTurns, userText)  → messages[]
  3. provider.chatCompletion(messages)   → responseText
  4. Strip markdown artifacts (*, #, etc.)
  5. line.replyMessage(replyToken, responseText)
  6. memory.saveTurn(userId, userText, responseText)

handleAudio(userId, replyToken, messageId):
  1. line.downloadContent(messageId)     → audioBuffer
  2. provider.transcribeAudio(audioBuffer) → userText
  3. handleText(userId, replyToken, userText)
```

### 4. Memory Service (`services/memory.mjs`)

DynamoDB-backed sliding window + summary compression.

**Read flow:**
```
getContext(userId):
  1. Query DynamoDB: pk=USER#{userId}, sk begins_with TURN# (limit last MAX_RECENT_TURNS)
  2. Get summary: pk=USER#{userId}, sk=SUMMARY
  3. Return { summary: string | null, recentTurns: [{role, content}] }
```

**Write flow:**
```
saveTurn(userId, userText, assistantText):
  1. Write two items:
     - pk=USER#{userId}, sk=TURN#{timestamp}#user,   content=userText,      ttl=now+30d
     - pk=USER#{userId}, sk=TURN#{timestamp}#asst,    content=assistantText, ttl=now+30d
  2. Count total turns for this user
  3. If total > MAX_RECENT_TURNS * 2:
     - Fetch oldest turns beyond the window
     - Call provider.summarize(existingSummary, oldTurns) → newSummary
     - Upsert SUMMARY item
     - Delete the old turn items
```

**Summary compression prompt:**
```
將以下對話歷史濃縮為不超過 500 字的繁體中文摘要，保留：
- 使用者提到的關鍵煩惱和情緒
- 諮商師給過的重要建議
- 對話的情感脈絡

舊摘要：{existingSummary}
需要壓縮的對話：{oldTurns}
```

### 5. LLM Providers (`providers/`)

**Interface (`base.mjs`):**
```javascript
class LlmProvider {
  async chatCompletion(messages) → string
  async summarize(existingSummary, turns) → string
  async transcribeAudio(audioBuffer) → string  // optional, OpenAI-only
}
```

**OpenAI (`openai.mjs`):**
- `chatCompletion` → POST `/v1/chat/completions`
- `summarize` → Same endpoint, lower temperature (0.3), uses `SUMMARY_MODEL_OPENAI`
- `transcribeAudio` → POST `/v1/audio/transcriptions` (Whisper)

**Anthropic (`anthropic.mjs`):**
- `chatCompletion` → POST `/v1/messages` with system prompt separated
- `summarize` → Same endpoint, lower temperature
- `transcribeAudio` → Falls back to OpenAI Whisper (Anthropic has no audio API)

**Provider factory:**
```javascript
function createProvider(providerName) {
  switch (providerName) {
    case 'openai':    return new OpenAiProvider()
    case 'anthropic': return new AnthropicProvider()
    default: throw new Error(`Unknown provider: ${providerName}`)
  }
}
```

### 6. Prompt (`prompt.mjs`)

Exports:
- `SYSTEM_PROMPT` — The full Diamond Sutra counselor prompt (carried over from Python version)
- `FEW_SHOT_EXAMPLES` — One user/assistant pair for tone calibration
- `buildMessages(summary, recentTurns, userInput)` — Assembles the final messages array:

```
[
  { role: "system", content: SYSTEM_PROMPT },
  { role: "system", content: `對話摘要：${summary}` },   // if summary exists
  ...FEW_SHOT_EXAMPLES,
  ...recentTurns,                                         // last 5 turns
  { role: "user", content: userInput }
]
```

## DynamoDB Table Design

**Table name:** `prajna-gate-conversations`

| Attribute | Type | Description |
|-----------|------|-------------|
| pk | S (partition key) | `USER#{userId}` |
| sk | S (sort key) | `TURN#{ISO-timestamp}#user` / `TURN#{ISO-timestamp}#asst` / `SUMMARY` |
| content | S | Message text or summary text |
| role | S | `user` / `assistant` (for turn items) |
| updatedAt | S | ISO timestamp (for summary item) |
| ttl | N | Unix epoch, auto-expire after 30 days |

**Access patterns:**
1. Get recent turns: Query `pk=USER#{id}`, `sk begins_with TURN#`, ScanIndexForward=false, Limit=MAX_RECENT_TURNS*2
2. Get summary: GetItem `pk=USER#{id}`, `sk=SUMMARY`
3. Delete old turns: BatchWriteItem delete after summary compression

## CDK Stack

**Resources created:**
- DynamoDB table (`prajna-gate-conversations`) with TTL enabled on `ttl` attribute
- Lambda function (Node.js 22.x, 256MB, 30s timeout)
- Lambda Function URL or HTTP API Gateway (simpler than REST API)
- IAM role granting Lambda → DynamoDB read/write

**CDK will NOT touch:**
- Existing `lambda_handler` function
- Existing `LambdaSimpleProxy` API Gateway
- Existing `TheDiamondSutraConversationSummaries` table

## Security

- LINE webhook signature verification via HMAC-SHA256 (the original Python version lacked this)
- API keys stored in Lambda environment variables (managed via CDK, sourced from `.env` at deploy time)
- DynamoDB TTL auto-cleans old conversations
- No secrets in source code; `.env` in `.gitignore`

## Migration / Cutover Plan

1. Deploy CDK stack → new Lambda + API Gateway + DynamoDB created
2. Test with curl or LINE webhook test
3. Go to LINE Developers Console → change webhook URL to new API Gateway endpoint
4. Verify bot responds correctly
5. Old Lambda remains intact, can switch back by reverting webhook URL

## Dependencies

Runtime (bundled with Lambda):
- None — uses Node.js 22.x native `fetch` and `crypto`

Dev:
- `aws-cdk-lib` + `constructs` (CDK)
- `dotenv` (local dev convenience, not deployed)
- `esbuild` (CDK bundling)
