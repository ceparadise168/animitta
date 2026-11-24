import { describe, it, expect } from '@jest/globals'
import { readdirSync, readFileSync } from 'node:fs'
import { problemsIn } from '../scripts/check-workflows.mjs'

describe('workflow check', () => {
  it('flags an aws lambda call that would print the bot\'s keys', () => {
    expect(problemsIn('run: aws lambda update-function-code --function-name animitta --zip-file fileb://new.zip', 'x.yml')).toHaveLength(1)
  })

  it('accepts a call that asks for one field, or prints nothing', () => {
    const text = 'aws lambda update-function-code --zip-file fileb://a.zip --query CodeSha256 --output text\naws lambda wait function-updated --function-name animitta > /dev/null'
    expect(problemsIn(text, 'x.yml')).toEqual([])
  })

  it('reads a call continued over several lines as one', () => {
    expect(problemsIn('aws lambda invoke \\\n  --function-name animitta out.json \\\n  --query StatusCode --output text', 'x.yml')).toEqual([])
  })

  it('flags pull_request_target', () => {
    expect(problemsIn('on:\n  pull_request_target:', 'x.yml')).toHaveLength(1)
  })

  it('finds nothing wrong in this repo\'s workflows', () => {
    const dir = '.github/workflows'
    const problems = readdirSync(dir).flatMap((file) => problemsIn(readFileSync(`${dir}/${file}`, 'utf8'), file))
    expect(problems).toEqual([])
  })
})
