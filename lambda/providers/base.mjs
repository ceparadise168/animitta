export class LlmProvider {
  /**
   * @param {Array<{role: string, content: string}>} messages
   * @returns {Promise<{text: string, suggestions?: string[]}>}
   */
  async chatCompletion(messages) {
    throw new Error('chatCompletion not implemented')
  }

  async summarize(existingSummary, turns) {
    throw new Error('summarize not implemented')
  }

  async transcribeAudio(audioBuffer) {
    throw new Error('transcribeAudio not implemented')
  }
}
