import { describe, it, expect, jest } from '@jest/globals'

const { selfTest } = await import('../lambda/self-test.mjs')

const answers = () => ({ chatCompletion: jest.fn().mockResolvedValue({ text: '好' }) })
const results = async (deps) => JSON.parse((await selfTest(deps)).body)

describe('selfTest', () => {
  it('reports each part working', async () => {
    const backup = { send: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '好' }] }) }

    expect(await results({ anthropic: answers(), backup, secret: 'line-secret' })).toEqual({ anthropic: 'ok', bedrock: 'ok', signature: 'ok' })
  })

  it('names what failed, by the bot\'s own failure message', async () => {
    const anthropic = { chatCompletion: jest.fn().mockRejectedValue(new Error('Anthropic chat failed: 401 authentication_error')) }
    const backup = { send: jest.fn().mockRejectedValue(new Error('Bedrock chat failed: 403 AccessDeniedException')) }

    expect(await results({ anthropic, backup, secret: 'line-secret' })).toEqual({
      anthropic: 'Anthropic chat failed: 401 authentication_error',
      bedrock: 'Bedrock chat failed: 403 AccessDeniedException',
      signature: 'ok',
    })
  })

  it('asks the model for worries too when there is one, and names it when it is the one that failed', async () => {
    const both = { answersWorries: true, chatCompletion: jest.fn().mockResolvedValue({ text: '好' }) }
    const wrongName = {
      answersWorries: true,
      chatCompletion: jest.fn(async (_, { worries } = {}) => {
        if (worries) throw new Error('Anthropic chat failed: 404 not_found_error')
        return { text: '好' }
      }),
    }

    expect((await results({ anthropic: both, backup: null, secret: 'line-secret' })).anthropic).toBe('ok')
    expect(both.chatCompletion.mock.calls.map(([, options]) => Boolean(options.worries))).toEqual([false, true])
    expect((await results({ anthropic: wrongName, backup: null, secret: 'line-secret' })).anthropic).toBe('model for worries: Anthropic chat failed: 404 not_found_error')
  })

  it('says the backup is off when none is configured, and when the LINE secret is missing', async () => {
    expect(await results({ anthropic: answers(), backup: null, secret: undefined })).toMatchObject({ bedrock: 'off', signature: 'no secret' })
  })

  it('asks the backup a short question with its own deadline', async () => {
    const backup = { send: jest.fn().mockResolvedValue({}) }

    await selfTest({ anthropic: answers(), backup, secret: 's' })

    const [op, body, signal] = backup.send.mock.calls[0]
    expect(op).toBe('chat')
    expect(body.max_tokens).toBeLessThanOrEqual(16)
    expect(signal).toBeInstanceOf(AbortSignal)
  })
})
