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
    return { text: data.content[0].text }
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
