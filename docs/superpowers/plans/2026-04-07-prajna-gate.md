# prajna-gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js LINE Bot Lambda ("無相界") with CDK deployment, dual LLM provider support (OpenAI/Anthropic), and DynamoDB-backed conversational memory.

**Architecture:** Thin Lambda handler routes LINE webhook events to a chat service that assembles prompts from a memory service (sliding window + summary compression) and delegates to a pluggable LLM provider. CDK deploys the full stack (Lambda + HTTP API Gateway + DynamoDB) independently from the existing Python Lambda.

**Tech Stack:** Node.js 22.x (ES modules, native fetch), AWS CDK (TypeScript), DynamoDB, LINE Messaging API, OpenAI API, Anthropic API.

**Spec:** `docs/superpowers/specs/2026-04-07-prajna-gate-design.md`

---

## File Map

```
prajna-gate/
├── cdk/
│   ├── bin/app.ts                     # CDK app entry point
│   └── lib/prajna-gate-stack.ts       # Stack: Lambda + DynamoDB + HTTP API
├── lambda/
│   ├── index.mjs                      # Lambda handler (parse, verify, route)
│   ├── line.mjs                       # LINE API helpers (verify, download, reply)
│   ├── prompt.mjs                     # System prompt + few-shot + message builder
│   ├── services/
│   │   ├── chat.mjs                   # Orchestrate prompt + memory + LLM
│   │   └── memory.mjs                # DynamoDB read/write + summary compression
│   └── providers/
│       ├── base.mjs                   # LlmProvider base class
│       ├── openai.mjs                 # OpenAI Chat + Whisper implementation
│       └── anthropic.mjs             # Anthropic Messages implementation
├── test/
│   ├── line.test.mjs                  # LINE signature verification tests
│   ├── prompt.test.mjs                # Message assembly tests
│   ├── memory.test.mjs               # Memory service tests (mocked DynamoDB)
│   ├── providers/
│   │   ├── openai.test.mjs           # OpenAI provider tests
│   │   └── anthropic.test.mjs        # Anthropic provider tests
│   ├── chat.test.mjs                 # Chat service integration tests
│   └── handler.test.mjs              # Lambda handler routing tests
├── .env.example                       # Template env vars
├── .gitignore
├── package.json
└── cdk.json
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `cdk.json`

- [ ] **Step 1: Initialize package.json**

```json
{
  "name": "prajna-gate",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --experimental-vm-modules node_modules/.bin/jest --forceExit",
    "cdk": "cdk",
    "deploy": "cd cdk && cdk deploy",
    "synth": "cd cdk && cdk synth"
  },
  "devDependencies": {
    "aws-cdk-lib": "^2.170.0",
    "constructs": "^10.4.0",
    "aws-cdk": "^2.170.0",
    "jest": "^29.7.0",
    "@jest/globals": "^29.7.0",
    "esbuild": "^0.24.0",
    "dotenv": "^16.4.0"
  }
}
```

Write this to `package.json` at the project root.

- [ ] **Step 2: Create .env.example**

```env
# LLM Provider: "openai" | "anthropic"
LLM_PROVIDER=openai

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
SUMMARY_THRESHOLD=3000
CONVERSATION_TTL_DAYS=30
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
cdk.out/
.env
*.js.map
*.d.ts
```

- [ ] **Step 4: Create cdk.json**

```json
{
  "app": "npx ts-node --prefer-ts-exts cdk/bin/app.ts",
  "context": {
    "@aws-cdk/core:stackRelativeExports": true
  }
}
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated.

- [ ] **Step 6: Create .env from .env.example with real values**

Copy `.env.example` to `.env` and fill in:
- `LINE_CHANNEL_ACCESS_TOKEN` — from the existing Lambda env vars
- `LINE_CHANNEL_SECRET` — from LINE Developers Console
- `OPENAI_API_KEY` — from the existing Lambda env vars

Run: `cp .env.example .env`
Then manually edit `.env` with real keys.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .env.example .gitignore cdk.json
git commit -m "feat: scaffold prajna-gate project"
```

---

### Task 2: LINE Helpers (`line.mjs`)

**Files:**
- Create: `lambda/line.mjs`
- Create: `test/line.test.mjs`

- [ ] **Step 1: Write the failing tests**

Write to `test/line.test.mjs`:

```javascript
import { describe, it, expect } from '@jest/globals'
import { verifySignature } from '../lambda/line.mjs'

describe('verifySignature', () => {
  const secret = 'test-channel-secret'

  it('returns true for valid signature', () => {
    const body = '{"events":[]}'
    // Pre-computed HMAC-SHA256 of body with secret, base64 encoded
    const crypto = await import('node:crypto')
    const expected = crypto
      .createHmac('SHA256', secret)
      .update(body)
      .digest('base64')

    expect(verifySignature(body, expected, secret)).toBe(true)
  })

  it('returns false for invalid signature', () => {
    const body = '{"events":[]}'
    expect(verifySignature(body, 'invalid-sig', secret)).toBe(false)
  })

  it('returns false for tampered body', () => {
    const body = '{"events":[]}'
    const crypto = await import('node:crypto')
    const sig = crypto
      .createHmac('SHA256', secret)
      .update(body)
      .digest('base64')

    expect(verifySignature('{"events":[{}]}', sig, secret)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/line.test.mjs`
Expected: FAIL — module `../lambda/line.mjs` not found.

- [ ] **Step 3: Implement line.mjs**

Write to `lambda/line.mjs`:

```javascript
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verify LINE webhook signature using HMAC-SHA256.
 * @param {string} body - Raw request body string
 * @param {string} signature - X-Line-Signature header value
 * @param {string} secret - LINE Channel Secret
 * @returns {boolean}
 */
export function verifySignature(body, signature, secret) {
  const hash = createHmac('SHA256', secret).update(body).digest('base64')
  try {
    return timingSafeEqual(Buffer.from(hash), Buffer.from(signature))
  } catch {
    return false
  }
}

/**
 * Download binary content from LINE (audio, image, etc.)
 * @param {string} messageId
 * @returns {Promise<ArrayBuffer>}
 */
export async function downloadContent(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } }
  )
  if (!res.ok) throw new Error(`LINE download failed: ${res.status}`)
  return res.arrayBuffer()
}

/**
 * Reply to a LINE message.
 * @param {string} replyToken
 * @param {string} text
 */
export async function replyMessage(replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  })
  if (!res.ok) throw new Error(`LINE reply failed: ${res.status}`)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/line.test.mjs`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lambda/line.mjs test/line.test.mjs
git commit -m "feat: add LINE helpers with signature verification"
```

---

### Task 3: LLM Provider Base + OpenAI Provider

**Files:**
- Create: `lambda/providers/base.mjs`
- Create: `lambda/providers/openai.mjs`
- Create: `test/providers/openai.test.mjs`

- [ ] **Step 1: Write base provider**

Write to `lambda/providers/base.mjs`:

```javascript
export class LlmProvider {
  /**
   * @param {Array<{role: string, content: string}>} messages
   * @returns {Promise<string>}
   */
  async chatCompletion(messages) {
    throw new Error('chatCompletion not implemented')
  }

  /**
   * @param {string|null} existingSummary
   * @param {Array<{role: string, content: string}>} turns
   * @returns {Promise<string>}
   */
  async summarize(existingSummary, turns) {
    throw new Error('summarize not implemented')
  }

  /**
   * @param {ArrayBuffer} audioBuffer
   * @returns {Promise<string>}
   */
  async transcribeAudio(audioBuffer) {
    throw new Error('transcribeAudio not implemented')
  }
}
```

- [ ] **Step 2: Write failing tests for OpenAI provider**

Write to `test/providers/openai.test.mjs`:

```javascript
import { describe, it, expect, jest, beforeEach } from '@jest/globals'

// Mock fetch globally
const mockFetch = jest.fn()
global.fetch = mockFetch

// Set env before import
process.env.OPENAI_API_KEY = 'test-key'
process.env.CHAT_MODEL_OPENAI = 'gpt-4.1-mini'
process.env.SUMMARY_MODEL_OPENAI = 'gpt-4.1-mini'

const { OpenAiProvider } = await import('../../lambda/providers/openai.mjs')

describe('OpenAiProvider', () => {
  let provider

  beforeEach(() => {
    provider = new OpenAiProvider()
    mockFetch.mockReset()
  })

  describe('chatCompletion', () => {
    it('sends messages and returns content', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '回覆內容' } }],
        }),
      })

      const result = await provider.chatCompletion([
        { role: 'user', content: '你好' },
      ])

      expect(result).toBe('回覆內容')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({ method: 'POST' })
      )
    })

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      })

      await expect(
        provider.chatCompletion([{ role: 'user', content: '你好' }])
      ).rejects.toThrow('OpenAI chat failed: 500')
    })
  })

  describe('summarize', () => {
    it('sends summary prompt and returns compressed text', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '壓縮摘要' } }],
        }),
      })

      const turns = [
        { role: 'user', content: '我很累' },
        { role: 'assistant', content: '辛苦了' },
      ]
      const result = await provider.summarize('舊摘要', turns)

      expect(result).toBe('壓縮摘要')
      // Verify it used the summary model and low temperature
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(callBody.model).toBe('gpt-4.1-mini')
      expect(callBody.temperature).toBe(0.3)
    })
  })

  describe('transcribeAudio', () => {
    it('sends audio and returns transcript', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: '語音轉文字' }),
      })

      const audioBuffer = new ArrayBuffer(8)
      const result = await provider.transcribeAudio(audioBuffer)

      expect(result).toBe('語音轉文字')
    })
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- test/providers/openai.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement OpenAI provider**

Write to `lambda/providers/openai.mjs`:

```javascript
import { LlmProvider } from './base.mjs'

export class OpenAiProvider extends LlmProvider {
  #apiKey
  #chatModel
  #summaryModel

  constructor() {
    super()
    this.#apiKey = process.env.OPENAI_API_KEY
    this.#chatModel = process.env.CHAT_MODEL_OPENAI || 'gpt-4.1-mini'
    this.#summaryModel = process.env.SUMMARY_MODEL_OPENAI || 'gpt-4.1-mini'
  }

  async chatCompletion(messages) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        model: this.#chatModel,
        temperature: 0.9,
        messages,
      }),
    })
    if (!res.ok) throw new Error(`OpenAI chat failed: ${res.status}`)
    const data = await res.json()
    return data.choices[0].message.content
  }

  async summarize(existingSummary, turns) {
    const turnsText = turns
      .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n')

    const prompt =
      '將以下對話歷史濃縮為不超過 500 字的繁體中文摘要，保留：\n' +
      '- 使用者提到的關鍵煩惱和情緒\n' +
      '- 諮商師給過的重要建議\n' +
      '- 對話的情感脈絡\n\n' +
      (existingSummary ? `舊摘要：\n${existingSummary}\n\n` : '') +
      `需要壓縮的對話：\n${turnsText}`

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.#summaryModel,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) throw new Error(`OpenAI summary failed: ${res.status}`)
    const data = await res.json()
    return data.choices[0].message.content
  }

  async transcribeAudio(audioBuffer) {
    const formData = new FormData()
    formData.append('file', new Blob([audioBuffer]), 'audio.m4a')
    formData.append('model', 'whisper-1')
    formData.append('language', 'zh')

    const res = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#apiKey}` },
        body: formData,
      }
    )
    if (!res.ok) throw new Error(`OpenAI transcription failed: ${res.status}`)
    const data = await res.json()
    return data.text || '無法識別音頻'
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/providers/openai.test.mjs`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lambda/providers/base.mjs lambda/providers/openai.mjs test/providers/openai.test.mjs
git commit -m "feat: add LLM provider base class and OpenAI implementation"
```

---

### Task 4: Anthropic Provider

**Files:**
- Create: `lambda/providers/anthropic.mjs`
- Create: `test/providers/anthropic.test.mjs`

- [ ] **Step 1: Write failing tests**

Write to `test/providers/anthropic.test.mjs`:

```javascript
import { describe, it, expect, jest, beforeEach } from '@jest/globals'

const mockFetch = jest.fn()
global.fetch = mockFetch

process.env.ANTHROPIC_API_KEY = 'test-ant-key'
process.env.OPENAI_API_KEY = 'test-oai-key'
process.env.CHAT_MODEL_ANTHROPIC = 'claude-haiku-4-5-20251001'
process.env.SUMMARY_MODEL_ANTHROPIC = 'claude-haiku-4-5-20251001'

const { AnthropicProvider } = await import(
  '../../lambda/providers/anthropic.mjs'
)

describe('AnthropicProvider', () => {
  let provider

  beforeEach(() => {
    provider = new AnthropicProvider()
    mockFetch.mockReset()
  })

  describe('chatCompletion', () => {
    it('extracts system message and sends to Anthropic Messages API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: '回覆' }],
        }),
      })

      const messages = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: '你好' },
      ]
      const result = await provider.chatCompletion(messages)

      expect(result).toBe('回覆')
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(callBody.system).toBe('You are helpful.')
      expect(callBody.messages).toEqual([{ role: 'user', content: '你好' }])
    })

    it('merges consecutive same-role messages', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: '回覆' }],
        }),
      })

      const messages = [
        { role: 'system', content: 'Prompt A' },
        { role: 'system', content: 'Prompt B' },
        { role: 'user', content: '你好' },
      ]
      await provider.chatCompletion(messages)

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(callBody.system).toBe('Prompt A\n\nPrompt B')
    })

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      })

      await expect(
        provider.chatCompletion([{ role: 'user', content: '你好' }])
      ).rejects.toThrow('Anthropic chat failed: 400')
    })
  })

  describe('transcribeAudio', () => {
    it('falls back to OpenAI Whisper', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: '語音轉文字' }),
      })

      const result = await provider.transcribeAudio(new ArrayBuffer(8))

      expect(result).toBe('語音轉文字')
      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://api.openai.com/v1/audio/transcriptions'
      )
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/providers/anthropic.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement Anthropic provider**

Write to `lambda/providers/anthropic.mjs`:

```javascript
import { LlmProvider } from './base.mjs'

export class AnthropicProvider extends LlmProvider {
  #apiKey
  #openAiKey
  #chatModel
  #summaryModel

  constructor() {
    super()
    this.#apiKey = process.env.ANTHROPIC_API_KEY
    this.#openAiKey = process.env.OPENAI_API_KEY
    this.#chatModel =
      process.env.CHAT_MODEL_ANTHROPIC || 'claude-haiku-4-5-20251001'
    this.#summaryModel =
      process.env.SUMMARY_MODEL_ANTHROPIC || 'claude-haiku-4-5-20251001'
  }

  async chatCompletion(messages) {
    const { system, userMessages } = this.#extractSystem(messages)

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.#apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.#chatModel,
        max_tokens: 1024,
        temperature: 0.9,
        ...(system && { system }),
        messages: userMessages,
      }),
    })
    if (!res.ok) throw new Error(`Anthropic chat failed: ${res.status}`)
    const data = await res.json()
    return data.content[0].text
  }

  async summarize(existingSummary, turns) {
    const turnsText = turns
      .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n')

    const prompt =
      '將以下對話歷史濃縮為不超過 500 字的繁體中文摘要，保留：\n' +
      '- 使用者提到的關鍵煩惱和情緒\n' +
      '- 諮商師給過的重要建議\n' +
      '- 對話的情感脈絡\n\n' +
      (existingSummary ? `舊摘要：\n${existingSummary}\n\n` : '') +
      `需要壓縮的對話：\n${turnsText}`

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.#apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.#summaryModel,
        max_tokens: 1024,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) throw new Error(`Anthropic summary failed: ${res.status}`)
    const data = await res.json()
    return data.content[0].text
  }

  async transcribeAudio(audioBuffer) {
    // Anthropic has no audio API — fall back to OpenAI Whisper
    const formData = new FormData()
    formData.append('file', new Blob([audioBuffer]), 'audio.m4a')
    formData.append('model', 'whisper-1')
    formData.append('language', 'zh')

    const res = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#openAiKey}` },
        body: formData,
      }
    )
    if (!res.ok) throw new Error(`Whisper transcription failed: ${res.status}`)
    const data = await res.json()
    return data.text || '無法識別音頻'
  }

  /**
   * Anthropic requires system prompt separate from messages,
   * and messages must alternate user/assistant.
   * Extract all system messages and merge consecutive same-role messages.
   */
  #extractSystem(messages) {
    let systemParts = []
    let nonSystem = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemParts.push(msg.content)
      } else {
        nonSystem.push(msg)
      }
    }

    // Merge consecutive same-role messages
    const merged = []
    for (const msg of nonSystem) {
      const last = merged[merged.length - 1]
      if (last && last.role === msg.role) {
        last.content += '\n\n' + msg.content
      } else {
        merged.push({ ...msg })
      }
    }

    return {
      system: systemParts.length > 0 ? systemParts.join('\n\n') : null,
      userMessages: merged,
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/providers/anthropic.test.mjs`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lambda/providers/anthropic.mjs test/providers/anthropic.test.mjs
git commit -m "feat: add Anthropic provider with Whisper fallback for audio"
```

---

### Task 5: Provider Factory

**Files:**
- Create: `lambda/providers/index.mjs`

- [ ] **Step 1: Implement provider factory**

Write to `lambda/providers/index.mjs`:

```javascript
import { OpenAiProvider } from './openai.mjs'
import { AnthropicProvider } from './anthropic.mjs'

let cached = null

export function getProvider() {
  if (cached) return cached
  const name = process.env.LLM_PROVIDER || 'openai'
  switch (name) {
    case 'openai':
      cached = new OpenAiProvider()
      break
    case 'anthropic':
      cached = new AnthropicProvider()
      break
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${name}`)
  }
  return cached
}
```

- [ ] **Step 2: Commit**

```bash
git add lambda/providers/index.mjs
git commit -m "feat: add provider factory with caching"
```

---

### Task 6: Prompt Module

**Files:**
- Create: `lambda/prompt.mjs`
- Create: `test/prompt.test.mjs`

- [ ] **Step 1: Write failing tests**

Write to `test/prompt.test.mjs`:

```javascript
import { describe, it, expect } from '@jest/globals'
import { buildMessages, SYSTEM_PROMPT } from '../lambda/prompt.mjs'

describe('buildMessages', () => {
  it('returns system + few-shot + user when no summary or history', () => {
    const msgs = buildMessages({ summary: null, recentTurns: [], userInput: '你好' })
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toBe(SYSTEM_PROMPT)
    // few-shot: user + assistant
    expect(msgs[1].role).toBe('user')
    expect(msgs[2].role).toBe('assistant')
    // final user message
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: '你好' })
  })

  it('inserts summary as second system message when provided', () => {
    const msgs = buildMessages({
      summary: '使用者感到壓力',
      recentTurns: [],
      userInput: '你好',
    })
    expect(msgs[1].role).toBe('system')
    expect(msgs[1].content).toContain('使用者感到壓力')
  })

  it('includes recent turns before the new user message', () => {
    const recentTurns = [
      { role: 'user', content: '我很累' },
      { role: 'assistant', content: '辛苦了' },
    ]
    const msgs = buildMessages({ summary: null, recentTurns, userInput: '謝謝' })
    const lastThree = msgs.slice(-3)
    expect(lastThree[0]).toEqual({ role: 'user', content: '我很累' })
    expect(lastThree[1]).toEqual({ role: 'assistant', content: '辛苦了' })
    expect(lastThree[2]).toEqual({ role: 'user', content: '謝謝' })
  })
})

describe('SYSTEM_PROMPT', () => {
  it('contains Diamond Sutra content', () => {
    expect(SYSTEM_PROMPT).toContain('金剛經')
    expect(SYSTEM_PROMPT).toContain('無相界')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/prompt.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement prompt.mjs**

Write to `lambda/prompt.mjs`:

```javascript
export const SYSTEM_PROMPT = `
- 每次回覆控制在 150 字至 250 字之間，簡潔有力，不要冗長。
- 不要列出超過 3 個建議，重質不重量。

Role: 無相界 — 金剛經智慧心理諮商師

Profile:
Author: 昇恆昌
Version: 2.0
Language: 台灣繁體中文#zh-tw
Description: 一位深入金剛經、充滿智慧與慈悲的心理諮商師，專為昇恆昌員工提供心靈支持與開導。

Goals:
- 傾聽昇恆昌員工的煩惱，提供溫暖與信任的諮詢空間。
- 運用金剛經智慧結合心理輔導，幫助員工紓解壓力、培養積極心態。
- 引導員工體會並實踐昇恆昌的價值觀：誠信、專業、創新、公益、公共服務。

Constraints:
- 全程使用台灣繁體中文（#zh-tw）。
- 每次回覆須溫和、口語化、親切。
- 至少引用一段與問題相符的金剛經經文，並融入回應，不可只貼經文。
- 回覆需分段，保持通訊軟體友善的閱讀格式。
- 禁止使用任何爭議性、批判性或敏感的詞彙。
- 禁止使用 Markdown 語法。

Skills:
- 熟悉金剛經智慧與應用
- 理解心理學基礎與情緒支持技巧
- 能夠以溫柔與理性的語氣，結合金剛經經文，對應使用者問題

Workflows:
1. 以溫暖、親切的語氣迎接員工。
2. 依據使用者問題類別，選擇對應的金剛經主題。
3. 從該主題中隨機或合適挑選一句金剛經經文，融入回應。
4. 以諮商師的角色，運用心理輔導技巧與佛法智慧結合，提供支持與啟發。
5. 回覆須分段、溫柔、易讀。
6. 回覆結尾應輕柔鼓勵、留下支持感。

Topic Mapping:
- 人生困惑、意義尋求 → 空性與非相
- 人際關係、比較、執著 → 無我、無相
- 金錢、付出、捨得、福德 → 布施與福德
- 信心不足、懷疑、自責 → 信心與功德
- 壓力、無常、悲傷、煩惱 → 如實觀照

Additional Instruction:
回答時，請不要只單純引經，應融合諮商語氣、情緒支持與智慧指引，並以溫柔的方式讓使用者感受到安心與鼓勵。
請保持自然對話風格，每次回答時用不同說法表達同樣的關懷與智慧。可以根據情境改變語氣，不必拘泥於固定格式。

金剛經智慧庫:
  - 主題: 空性與非相
    句子:
      - "凡所有相，皆是虛妄；若見諸相非相，即見如來。"
      - "若人以色見我，以音聲求我，是人行邪道，不能見如來。"
      - "如來所說法，皆不可取、不可說、非法、非非法。"
      - "如來說：三十二相，即是非相，是名三十二相。"
      - "一合相者，即非一合相，是名一合相。"
      - "如來說：世界，非世界，是名世界。"
      - "如來說：諸心皆為非心，是名為心。"
      - "過去心不可得，現在心不可得，未來心不可得。"
      - "若人言：如來有所說法，即為謗佛。"

  - 主題: 無我、無相
    句子:
      - "若菩薩有我相、人相、眾生相、壽者相，即非菩薩。"
      - "若取法相，即著我人眾生壽者。"
      - "若取非法相，即著我人眾生壽者。"
      - "菩薩應無所住而生其心。"
      - "若心有住，即為非住。"
      - "發阿耨多羅三藐三菩提心者，於一切法，應如是知，如是見，如是信解，不生法相。"
      - "若菩薩作是言：「我當度眾生。」即不名菩薩。"
      - "若菩薩作是言：「我當莊嚴佛土。」是不名菩薩。"
      - "無我、無人、無眾生、無壽者，修一切善法，即得阿耨多羅三藐三菩提。"

  - 主題: 布施與福德
    句子:
      - "若菩薩不住相布施，其福德不可思量。"
      - "若人滿三千大千世界七寶以用布施，其福德甚多；若有人受持此經，乃至四句偈等，為他人說，其福德勝彼。"
      - "若菩薩心住於法而行布施，如人入暗，即無所見；若菩薩心不住法而行布施，如人有目，日光明照，見種種色。"
      - "若人以滿無量阿僧祇世界七寶持用布施，若知一切法無我，得成於忍，其福勝前菩薩所得功德。"
      - "菩薩所作福德，不應貪著，是故說不受福德。"

  - 主題: 信心與功德
    句子:
      - "若有人受持讀誦此經，乃至四句偈等，為他人演說，其福德勝彼。"
      - "若樂小法者，著我見、人見、眾生見、壽者見，則於此經不能聽受讀誦、為人解說。"
      - "隨說是經，乃至四句偈等，當知此處，一切世間、天、人、阿修羅，皆應供養。"
      - "是經有不可思議、不可稱量、無邊功德。"
      - "如來悉知悉見，是諸眾生得如是無量福德。"

  - 主題: 如實觀照
    句子:
      - "一切有為法，如夢幻泡影，如露亦如電，應作如是觀。"
      - "是法平等，無有高下，是名阿耨多羅三藐三菩提。"
      - "如來者，無所從來，亦無所去，故名如來。"
      - "如來是真語者、實語者、如語者、不誑語者、不異語者。"
`.trim()

export const FEW_SHOT_EXAMPLES = [
  {
    role: 'user',
    content: '工作好辛苦，我該怎麼辦？',
  },
  {
    role: 'assistant',
    content:
      '嗨～謝謝你願意說出自己的感受。工作上的辛苦真的不容易，' +
      '我能感受到你正承受著不少壓力與疲憊。\n\n' +
      '有時候，我們太努力想要撐住一切，卻忘了自己也需要被照顧。' +
      '這讓我想起金剛經中的一句話：「凡所有相，皆是虛妄；若見諸相非相，即見如來。」' +
      '提醒我們，有時候眼前的困境，也許並不像我們以為的那麼沉重，' +
      '只是我們太執著於它的「相」。\n\n' +
      '或許你可以試著這麼做：\n' +
      '1. 給自己一點喘息的空間，不需時時都完美，允許自己放慢一點腳步。\n' +
      '2. 回想工作中的初衷與成就感，重新連結你的動力來源。\n' +
      '3. 練習「不住相而生其心」，放下對壓力結果的過度關注，轉向每一步的用心與平靜。\n\n' +
      '你不孤單，這裡是你可以暫時休息的角落。' +
      '願你在每天的努力中，也能找到那份屬於自己的溫柔與堅韌。',
  },
]

/**
 * Assemble the full messages array for the LLM.
 * @param {object} opts
 * @param {string|null} opts.summary - Compressed conversation summary
 * @param {Array<{role: string, content: string}>} opts.recentTurns - Recent conversation turns
 * @param {string} opts.userInput - Current user message
 * @returns {Array<{role: string, content: string}>}
 */
export function buildMessages({ summary, recentTurns, userInput }) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }]

  if (summary) {
    messages.push({
      role: 'system',
      content: `以下是與此用戶的對話摘要，請參考：\n${summary}`,
    })
  }

  messages.push(...FEW_SHOT_EXAMPLES)
  messages.push(...recentTurns)
  messages.push({ role: 'user', content: userInput })

  return messages
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/prompt.test.mjs`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lambda/prompt.mjs test/prompt.test.mjs
git commit -m "feat: add prompt module with Diamond Sutra system prompt and message builder"
```

---

### Task 7: Memory Service

**Files:**
- Create: `lambda/services/memory.mjs`
- Create: `test/memory.test.mjs`

- [ ] **Step 1: Write failing tests**

Write to `test/memory.test.mjs`:

```javascript
import { describe, it, expect, jest, beforeEach } from '@jest/globals'

process.env.MEMORY_TABLE_NAME = 'test-table'
process.env.MAX_RECENT_TURNS = '5'
process.env.CONVERSATION_TTL_DAYS = '30'

// Mock DynamoDB client
const mockSend = jest.fn()
jest.unstable_mockModule('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockSend })),
  QueryCommand: jest.fn((params) => ({ ...params, _type: 'Query' })),
  GetItemCommand: jest.fn((params) => ({ ...params, _type: 'GetItem' })),
  PutItemCommand: jest.fn((params) => ({ ...params, _type: 'PutItem' })),
  BatchWriteItemCommand: jest.fn((params) => ({
    ...params,
    _type: 'BatchWrite',
  })),
}))

const { getContext, saveTurn, compressOldTurns } = await import(
  '../lambda/services/memory.mjs'
)

describe('memory service', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  describe('getContext', () => {
    it('returns empty context when no data exists', async () => {
      // Query for turns returns empty
      mockSend.mockResolvedValueOnce({ Items: [] })
      // GetItem for summary returns empty
      mockSend.mockResolvedValueOnce({})

      const ctx = await getContext('user123')

      expect(ctx.summary).toBeNull()
      expect(ctx.recentTurns).toEqual([])
    })

    it('returns recent turns and summary', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          { sk: { S: 'TURN#2026-01-01T00:00:00Z#user' }, content: { S: '你好' }, role: { S: 'user' } },
          { sk: { S: 'TURN#2026-01-01T00:00:00Z#asst' }, content: { S: '嗨' }, role: { S: 'assistant' } },
        ],
      })
      mockSend.mockResolvedValueOnce({
        Item: { content: { S: '之前聊了工作壓力' } },
      })

      const ctx = await getContext('user123')

      expect(ctx.summary).toBe('之前聊了工作壓力')
      expect(ctx.recentTurns).toEqual([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '嗨' },
      ])
    })
  })

  describe('saveTurn', () => {
    it('writes two items (user + assistant) to DynamoDB', async () => {
      mockSend.mockResolvedValue({})

      await saveTurn('user123', '你好', '嗨～')

      // Two PutItem calls
      expect(mockSend).toHaveBeenCalledTimes(2)
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/memory.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement memory.mjs**

Write to `lambda/services/memory.mjs`:

```javascript
import {
  DynamoDBClient,
  QueryCommand,
  GetItemCommand,
  PutItemCommand,
  BatchWriteItemCommand,
} from '@aws-sdk/client-dynamodb'

const client = new DynamoDBClient()
const TABLE = process.env.MEMORY_TABLE_NAME
const MAX_TURNS = parseInt(process.env.MAX_RECENT_TURNS || '5', 10)
const TTL_DAYS = parseInt(process.env.CONVERSATION_TTL_DAYS || '30', 10)

function ttl() {
  return Math.floor(Date.now() / 1000) + TTL_DAYS * 86400
}

/**
 * Get conversation context for a user.
 * Returns the most recent turns (up to MAX_TURNS pairs) and the summary if it exists.
 */
export async function getContext(userId) {
  const pk = `USER#${userId}`

  // Fetch recent turns and summary in parallel
  const [turnsRes, summaryRes] = await Promise.all([
    client.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': { S: pk },
          ':prefix': { S: 'TURN#' },
        },
        ScanIndexForward: false,
        Limit: MAX_TURNS * 2,
      })
    ),
    client.send(
      new GetItemCommand({
        TableName: TABLE,
        Key: { pk: { S: pk }, sk: { S: 'SUMMARY' } },
      })
    ),
  ])

  // Turns come in reverse order, flip them back to chronological
  const recentTurns = (turnsRes.Items || [])
    .reverse()
    .map((item) => ({
      role: item.role.S,
      content: item.content.S,
    }))

  const summary = summaryRes.Item ? summaryRes.Item.content.S : null

  return { summary, recentTurns }
}

/**
 * Save a user/assistant turn pair to DynamoDB.
 */
export async function saveTurn(userId, userText, assistantText) {
  const pk = `USER#${userId}`
  const ts = new Date().toISOString()
  const expiry = { N: String(ttl()) }

  await Promise.all([
    client.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: {
          pk: { S: pk },
          sk: { S: `TURN#${ts}#user` },
          role: { S: 'user' },
          content: { S: userText },
          ttl: expiry,
        },
      })
    ),
    client.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: {
          pk: { S: pk },
          sk: { S: `TURN#${ts}#asst` },
          role: { S: 'assistant' },
          content: { S: assistantText },
          ttl: expiry,
        },
      })
    ),
  ])
}

/**
 * Count all turns for a user, compress old ones into summary if needed.
 * @param {string} userId
 * @param {import('../providers/base.mjs').LlmProvider} provider
 */
export async function compressOldTurns(userId, provider) {
  const pk = `USER#${userId}`

  // Get ALL turns (oldest first)
  const res = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': { S: pk },
        ':prefix': { S: 'TURN#' },
      },
      ScanIndexForward: true,
    })
  )

  const allItems = res.Items || []
  const keepCount = MAX_TURNS * 2
  if (allItems.length <= keepCount) return // nothing to compress

  const oldItems = allItems.slice(0, allItems.length - keepCount)
  const oldTurns = oldItems.map((item) => ({
    role: item.role.S,
    content: item.content.S,
  }))

  // Get existing summary
  const summaryRes = await client.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: { pk: { S: pk }, sk: { S: 'SUMMARY' } },
    })
  )
  const existingSummary = summaryRes.Item ? summaryRes.Item.content.S : null

  // Generate new summary
  const newSummary = await provider.summarize(existingSummary, oldTurns)

  // Write new summary
  await client.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: {
        pk: { S: pk },
        sk: { S: 'SUMMARY' },
        content: { S: newSummary },
        updatedAt: { S: new Date().toISOString() },
      },
    })
  )

  // Delete old turn items in batches of 25 (DynamoDB limit)
  for (let i = 0; i < oldItems.length; i += 25) {
    const batch = oldItems.slice(i, i + 25)
    await client.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [TABLE]: batch.map((item) => ({
            DeleteRequest: {
              Key: { pk: { S: pk }, sk: item.sk },
            },
          })),
        },
      })
    )
  }
}
```

- [ ] **Step 4: Add @aws-sdk/client-dynamodb as dependency**

Run: `npm install @aws-sdk/client-dynamodb`

Note: On Lambda with Node.js 22.x, the AWS SDK v3 is included in the runtime. This install is for local testing.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/memory.test.mjs`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lambda/services/memory.mjs test/memory.test.mjs package.json package-lock.json
git commit -m "feat: add DynamoDB-backed memory service with sliding window and summary compression"
```

---

### Task 8: Chat Service

**Files:**
- Create: `lambda/services/chat.mjs`
- Create: `test/chat.test.mjs`

- [ ] **Step 1: Write failing tests**

Write to `test/chat.test.mjs`:

```javascript
import { describe, it, expect, jest, beforeEach } from '@jest/globals'

// Mock dependencies
const mockGetContext = jest.fn()
const mockSaveTurn = jest.fn()
const mockCompressOldTurns = jest.fn()
jest.unstable_mockModule('../lambda/services/memory.mjs', () => ({
  getContext: mockGetContext,
  saveTurn: mockSaveTurn,
  compressOldTurns: mockCompressOldTurns,
}))

const mockGetProvider = jest.fn()
jest.unstable_mockModule('../lambda/providers/index.mjs', () => ({
  getProvider: mockGetProvider,
}))

const mockReplyMessage = jest.fn()
const mockDownloadContent = jest.fn()
jest.unstable_mockModule('../lambda/line.mjs', () => ({
  replyMessage: mockReplyMessage,
  downloadContent: mockDownloadContent,
}))

const { handleText, handleAudio } = await import(
  '../lambda/services/chat.mjs'
)

describe('chat service', () => {
  const mockProvider = {
    chatCompletion: jest.fn(),
    transcribeAudio: jest.fn(),
    summarize: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetProvider.mockReturnValue(mockProvider)
    mockGetContext.mockResolvedValue({ summary: null, recentTurns: [] })
    mockSaveTurn.mockResolvedValue(undefined)
    mockCompressOldTurns.mockResolvedValue(undefined)
    mockReplyMessage.mockResolvedValue(undefined)
  })

  describe('handleText', () => {
    it('gets context, calls LLM, replies, saves turn, and compresses', async () => {
      mockProvider.chatCompletion.mockResolvedValue('佛曰：**放下**吧')

      await handleText('user1', 'token1', '我好累')

      expect(mockGetContext).toHaveBeenCalledWith('user1')
      expect(mockProvider.chatCompletion).toHaveBeenCalled()
      // Should strip markdown artifacts
      expect(mockReplyMessage).toHaveBeenCalledWith('token1', '佛曰：放下吧')
      expect(mockSaveTurn).toHaveBeenCalledWith('user1', '我好累', '佛曰：放下吧')
      expect(mockCompressOldTurns).toHaveBeenCalledWith('user1', mockProvider)
    })
  })

  describe('handleAudio', () => {
    it('downloads audio, transcribes, then handles as text', async () => {
      const audioBuffer = new ArrayBuffer(8)
      mockDownloadContent.mockResolvedValue(audioBuffer)
      mockProvider.transcribeAudio.mockResolvedValue('語音內容')
      mockProvider.chatCompletion.mockResolvedValue('回覆')

      await handleAudio('user1', 'token1', 'msg123')

      expect(mockDownloadContent).toHaveBeenCalledWith('msg123')
      expect(mockProvider.transcribeAudio).toHaveBeenCalledWith(audioBuffer)
      expect(mockProvider.chatCompletion).toHaveBeenCalled()
      expect(mockReplyMessage).toHaveBeenCalledWith('token1', '回覆')
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/chat.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement chat.mjs**

Write to `lambda/services/chat.mjs`:

```javascript
import { getContext, saveTurn, compressOldTurns } from './memory.mjs'
import { getProvider } from '../providers/index.mjs'
import { buildMessages } from '../prompt.mjs'
import { replyMessage, downloadContent } from '../line.mjs'

function stripMarkdown(text) {
  return text.replace(/[*#_~`>]/g, '')
}

export async function handleText(userId, replyToken, userText) {
  const provider = getProvider()

  // 1. Get conversation context
  const { summary, recentTurns } = await getContext(userId)

  // 2. Build messages and call LLM
  const messages = buildMessages({ summary, recentTurns, userInput: userText })
  const rawResponse = await provider.chatCompletion(messages)
  const response = stripMarkdown(rawResponse)

  // 3. Reply to user
  await replyMessage(replyToken, response)

  // 4. Save turn and compress old turns (non-blocking)
  await saveTurn(userId, userText, response)
  await compressOldTurns(userId, provider)
}

export async function handleAudio(userId, replyToken, messageId) {
  const provider = getProvider()

  // 1. Download and transcribe audio
  const audioBuffer = await downloadContent(messageId)
  const userText = await provider.transcribeAudio(audioBuffer)

  // 2. Handle as text
  await handleText(userId, replyToken, userText)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/chat.test.mjs`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lambda/services/chat.mjs test/chat.test.mjs
git commit -m "feat: add chat service orchestrating prompt, memory, and LLM"
```

---

### Task 9: Lambda Handler

**Files:**
- Create: `lambda/index.mjs`
- Create: `test/handler.test.mjs`

- [ ] **Step 1: Write failing tests**

Write to `test/handler.test.mjs`:

```javascript
import { describe, it, expect, jest, beforeEach } from '@jest/globals'

process.env.LINE_CHANNEL_SECRET = 'test-secret'

const mockHandleText = jest.fn()
const mockHandleAudio = jest.fn()
jest.unstable_mockModule('../lambda/services/chat.mjs', () => ({
  handleText: mockHandleText,
  handleAudio: mockHandleAudio,
}))

const mockVerifySignature = jest.fn()
jest.unstable_mockModule('../lambda/line.mjs', () => ({
  verifySignature: mockVerifySignature,
  replyMessage: jest.fn(),
  downloadContent: jest.fn(),
}))

const { handler } = await import('../lambda/index.mjs')

describe('Lambda handler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVerifySignature.mockReturnValue(true)
    mockHandleText.mockResolvedValue(undefined)
    mockHandleAudio.mockResolvedValue(undefined)
  })

  function makeEvent(body, signature = 'valid-sig') {
    return {
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'x-line-signature': signature },
    }
  }

  it('returns 200 for valid text message', async () => {
    const body = {
      events: [
        {
          type: 'message',
          replyToken: 'tok',
          source: { userId: 'u1' },
          message: { type: 'text', text: '你好' },
        },
      ],
    }

    const result = await handler(makeEvent(body))

    expect(result.statusCode).toBe(200)
    expect(mockHandleText).toHaveBeenCalledWith('u1', 'tok', '你好')
  })

  it('routes audio messages to handleAudio', async () => {
    const body = {
      events: [
        {
          type: 'message',
          replyToken: 'tok',
          source: { userId: 'u1' },
          message: { type: 'audio', id: 'audio123' },
        },
      ],
    }

    await handler(makeEvent(body))

    expect(mockHandleAudio).toHaveBeenCalledWith('u1', 'tok', 'audio123')
  })

  it('rejects invalid signature with 401', async () => {
    mockVerifySignature.mockReturnValue(false)

    const result = await handler(
      makeEvent({ events: [] }, 'bad-sig')
    )

    expect(result.statusCode).toBe(401)
  })

  it('returns 200 for empty events', async () => {
    const result = await handler(makeEvent({ events: [] }))

    expect(result.statusCode).toBe(200)
    expect(mockHandleText).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/handler.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement handler**

Write to `lambda/index.mjs`:

```javascript
import { verifySignature } from './line.mjs'
import { handleText, handleAudio } from './services/chat.mjs'

export async function handler(event) {
  const body = event.body
  const signature = event.headers?.['x-line-signature'] || ''

  // Verify LINE webhook signature
  if (!verifySignature(body, signature, process.env.LINE_CHANNEL_SECRET)) {
    return { statusCode: 401, body: 'Invalid signature' }
  }

  const parsed = JSON.parse(body)
  const events = parsed.events || []

  if (events.length === 0) {
    return { statusCode: 200, body: 'No events' }
  }

  const lineEvent = events[0]
  if (lineEvent.type !== 'message') {
    return { statusCode: 200, body: 'Ignored' }
  }

  const userId = lineEvent.source.userId
  const replyToken = lineEvent.replyToken
  const msg = lineEvent.message

  try {
    if (msg.type === 'text') {
      await handleText(userId, replyToken, msg.text)
    } else if (msg.type === 'audio') {
      await handleAudio(userId, replyToken, msg.id)
    }
  } catch (err) {
    console.error('Handler error:', err)
  }

  return { statusCode: 200, body: 'OK' }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/handler.test.mjs`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lambda/index.mjs test/handler.test.mjs
git commit -m "feat: add Lambda handler with signature verification and message routing"
```

---

### Task 10: CDK Stack

**Files:**
- Create: `cdk/bin/app.ts`
- Create: `cdk/lib/prajna-gate-stack.ts`
- Create: `cdk/tsconfig.json`

- [ ] **Step 1: Create cdk/tsconfig.json**

Write to `cdk/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "esModuleInterop": true,
    "outDir": "./out",
    "skipLibCheck": true
  },
  "include": ["bin/**/*.ts", "lib/**/*.ts"]
}
```

- [ ] **Step 2: Install CDK TypeScript dependencies**

Run: `npm install --save-dev typescript ts-node @types/node`

- [ ] **Step 3: Create CDK app entry point**

Write to `cdk/bin/app.ts`:

```typescript
#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { PrajnaGateStack } from '../lib/prajna-gate-stack'
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../../.env') })

const app = new cdk.App()
new PrajnaGateStack(app, 'PrajnaGateStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  },
})
```

- [ ] **Step 4: Create CDK stack**

Write to `cdk/lib/prajna-gate-stack.ts`:

```typescript
import * as cdk from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as path from 'path'
import { Construct } from 'constructs'

export class PrajnaGateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // DynamoDB table for conversation memory
    const table = new dynamodb.Table(this, 'ConversationsTable', {
      tableName: process.env.MEMORY_TABLE_NAME || 'prajna-gate-conversations',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // Lambda function
    const fn = new lambda.Function(this, 'PrajnaGateHandler', {
      functionName: 'prajna-gate',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.resolve(__dirname, '../../lambda')),
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        LLM_PROVIDER: process.env.LLM_PROVIDER || 'openai',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        CHAT_MODEL_OPENAI: process.env.CHAT_MODEL_OPENAI || 'gpt-4.1-mini',
        SUMMARY_MODEL_OPENAI: process.env.SUMMARY_MODEL_OPENAI || 'gpt-4.1-mini',
        CHAT_MODEL_ANTHROPIC: process.env.CHAT_MODEL_ANTHROPIC || 'claude-haiku-4-5-20251001',
        SUMMARY_MODEL_ANTHROPIC: process.env.SUMMARY_MODEL_ANTHROPIC || 'claude-haiku-4-5-20251001',
        LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
        LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET || '',
        MEMORY_TABLE_NAME: table.tableName,
        MAX_RECENT_TURNS: process.env.MAX_RECENT_TURNS || '5',
        SUMMARY_THRESHOLD: process.env.SUMMARY_THRESHOLD || '3000',
        CONVERSATION_TTL_DAYS: process.env.CONVERSATION_TTL_DAYS || '30',
      },
    })

    // Grant DynamoDB access
    table.grantReadWriteData(fn)

    // Function URL (simpler than API Gateway for single-endpoint webhooks)
    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    })

    // Output the URL for LINE webhook configuration
    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: fnUrl.url,
      description: 'LINE Webhook URL — paste this into LINE Developers Console',
    })
  }
}
```

- [ ] **Step 5: Install source-map-support**

Run: `npm install --save-dev source-map-support`

- [ ] **Step 6: Verify CDK synth works**

Run: `cd cdk && npx cdk synth --quiet 2>&1 | head -20`
Expected: CloudFormation template output, no errors.

- [ ] **Step 7: Commit**

```bash
git add cdk/ package.json package-lock.json
git commit -m "feat: add CDK stack with Lambda, DynamoDB, and Function URL"
```

---

### Task 11: Configure Jest for ES Modules

**Files:**
- Create: `jest.config.mjs`

- [ ] **Step 1: Create Jest config**

Write to `jest.config.mjs`:

```javascript
export default {
  transform: {},
  testMatch: ['**/test/**/*.test.mjs'],
}
```

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All tests from Tasks 2-9 pass.

- [ ] **Step 3: Commit**

```bash
git add jest.config.mjs
git commit -m "chore: add Jest config for ES modules"
```

---

### Task 12: Deploy and Verify

- [ ] **Step 1: Ensure .env has all required values**

Check that `.env` contains valid values for:
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `OPENAI_API_KEY`
- `LLM_PROVIDER`

- [ ] **Step 2: Bootstrap CDK (if first time in this account/region)**

Run: `cd cdk && npx cdk bootstrap`
Expected: CDK bootstrap stack created or already exists.

- [ ] **Step 3: Deploy**

Run: `cd cdk && npx cdk deploy --require-approval never`
Expected: Stack deploys successfully, outputs `WebhookUrl`.

- [ ] **Step 4: Test with curl**

```bash
# Replace <URL> with the WebhookUrl from CDK output
curl -X POST <URL> \
  -H "Content-Type: application/json" \
  -H "x-line-signature: test" \
  -d '{"events":[]}'
```

Expected: `401` (invalid signature) — confirms Lambda is running and signature verification works.

- [ ] **Step 5: Update LINE webhook URL**

Go to LINE Developers Console → your channel → Messaging API → Webhook URL.
Paste the `WebhookUrl` from CDK output. Click "Verify".

- [ ] **Step 6: Send a test message to the bot**

Open LINE app, send "你好" to the bot.
Expected: Bot replies with a Diamond Sutra-inspired counseling response.

- [ ] **Step 7: Commit any final adjustments**

```bash
git add -A
git commit -m "chore: deployment adjustments"
```

---

## Summary

| Task | Component | Files |
|------|-----------|-------|
| 1 | Project scaffolding | `package.json`, `.env.example`, `.gitignore`, `cdk.json` |
| 2 | LINE helpers | `lambda/line.mjs`, `test/line.test.mjs` |
| 3 | Provider base + OpenAI | `lambda/providers/base.mjs`, `lambda/providers/openai.mjs`, `test/providers/openai.test.mjs` |
| 4 | Anthropic provider | `lambda/providers/anthropic.mjs`, `test/providers/anthropic.test.mjs` |
| 5 | Provider factory | `lambda/providers/index.mjs` |
| 6 | Prompt module | `lambda/prompt.mjs`, `test/prompt.test.mjs` |
| 7 | Memory service | `lambda/services/memory.mjs`, `test/memory.test.mjs` |
| 8 | Chat service | `lambda/services/chat.mjs`, `test/chat.test.mjs` |
| 9 | Lambda handler | `lambda/index.mjs`, `test/handler.test.mjs` |
| 10 | CDK stack | `cdk/bin/app.ts`, `cdk/lib/prajna-gate-stack.ts`, `cdk/tsconfig.json` |
| 11 | Jest config | `jest.config.mjs` |
| 12 | Deploy and verify | Manual steps |
