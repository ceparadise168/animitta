import { describe, it, expect } from '@jest/globals'
import { problemsIn } from '../scripts/check-workflows.mjs'

const flagged = (text) => problemsIn(text, 'x.yml').length > 0

describe('workflow check', () => {
  it('flags an aws lambda call that would print the bot\'s keys', () => {
    expect(flagged('run: aws lambda update-function-code --function-name animitta --zip-file fileb://new.zip')).toBe(true)
  })

  it('accepts a call that asks for one listed field, or prints nothing', () => {
    expect(flagged('aws lambda update-function-code --zip-file fileb://a.zip --query CodeSha256 --output text')).toBe(false)
    expect(flagged("url=$(aws lambda get-function --function-name f --query 'Code.Location' --output text)")).toBe(false)
    expect(flagged('aws lambda wait function-updated --function-name animitta > /dev/null')).toBe(false)
  })

  it('reads a call continued over several lines as one', () => {
    expect(flagged('aws lambda invoke \\\n  --function-name animitta out.json \\\n  --query StatusCode --output text')).toBe(false)
  })

  it.each([
    ['global options before the service', 'aws --region ap-northeast-1 lambda update-function-code --zip-file fileb://a.zip'],
    ['only stderr silenced', 'aws lambda get-function --function-name f 2>/dev/null'],
    ['a field that holds the keys', 'aws lambda get-function-configuration --function-name f --query Environment'],
    ['the whole answer asked for', "aws lambda get-function --function-name f --query '@'"],
    ['--debug', 'aws lambda invoke --function-name f out.json --query StatusCode --debug'],
    ['--query only in a comment', 'aws lambda update-function-code --zip-file fileb://a.zip # --query CodeSha256'],
    ['another command silenced instead', 'aws lambda update-function-code --zip-file fileb://a.zip; echo done > /dev/null'],
  ])('flags %s', (_, text) => {
    expect(flagged(text)).toBe(true)
  })

  it('flags triggers that run with secrets on code others control', () => {
    expect(flagged('on:\n  pull_request_target:')).toBe(true)
    expect(flagged('on:\n  workflow_run:')).toBe(true)
  })
})
