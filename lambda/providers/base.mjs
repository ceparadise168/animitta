export class LlmProvider {
  /**
   * @param {Array<{role: string, content: string}>} messages
   * @param {{signal?: AbortSignal}} [options] aborts the request when it fires
   * @returns {Promise<{text: string}>}
   */
  async chatCompletion(messages, options) {
    throw new Error('chatCompletion not implemented')
  }

  async summarize(existingSummary, turns) {
    throw new Error('summarize not implemented')
  }
}
