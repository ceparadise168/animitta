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
    return { text: data.choices[0].message.content }
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
