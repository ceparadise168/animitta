export class LlmProvider {
  /**
   * @param {Array<{role: string, content: string}>} messages
   * @param {{signal?: AbortSignal, worries?: boolean}} [options] signal aborts the request when it fires
   * @returns {Promise<{text: string}>}
   */
  async chatCompletion(messages, options) {
    throw new Error('chatCompletion not implemented')
  }

  async summarize(existingSummary, turns) {
    throw new Error('summarize not implemented')
  }

  /**
   * A short question answered in a word. Callers go on without the answer
   * when it fails.
   * @param {string} question
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<string>}
   */
  async ask(question, options) {
    throw new Error('ask not implemented')
  }

  /** Whether worries go to a model of their own (chatCompletion's worries option). */
  get answersWorries() {
    return false
  }
}
