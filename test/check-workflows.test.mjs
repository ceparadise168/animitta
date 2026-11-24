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
    ['a # inside quotes before it', 'echo "step #1" && aws lambda get-function-configuration --function-name f'],
    ['two --query, the last one wins', 'aws lambda get-function-configuration --function-name f --query CodeSha256 --query Environment'],
    ['a query that returns more than the field', "aws lambda get-function-configuration --function-name f --query 'CodeSha256 && Environment'"],
    ['the service name quoted', "aws 'lambda' get-function-configuration --function-name f"],
    ['a call inside $(...) without --query', 'cfg=$(aws lambda get-function-configuration --function-name f)'],
    ['a call inside quotes', 'echo "::notice::$(aws lambda get-function-configuration --function-name "$FUNCTION")"'],
    ['a call handed to bash -c', "bash -c 'aws lambda get-function-configuration --function-name f'"],
    ['a call inside process substitution', 'diff <(aws lambda get-function-configuration --function-name f) old.json'],
    ['aws by its full path', '/usr/local/bin/aws lambda get-function-configuration --function-name f'],
    ['a call after a single &', 'aws lambda wait function-updated --function-name f > /dev/null & aws lambda get-function --function-name f'],
    ['captured output silenced outside', 'x=$(aws lambda get-function-configuration --function-name f) > /dev/null'],
    ['a later redirect that is not /dev/null', 'aws lambda get-function --function-name f > /dev/null > out.json'],
    ['a redirect that is only text', "aws lambda update-function-code --zip-file fileb://a.zip --description '> /dev/null'"],
  ])('flags %s', (_, text) => {
    expect(flagged(text)).toBe(true)
  })

  it('flags triggers that run with secrets on code others control', () => {
    expect(flagged('on:\n  pull_request_target:')).toBe(true)
    expect(flagged('on:\n  workflow_run:')).toBe(true)
    expect(flagged('on: [pull_request_target]')).toBe(true)
    expect(flagged('on: [push, workflow_run]')).toBe(true)
    expect(flagged('on: {pull_request_target: {}}')).toBe(true)
  })

  it('still accepts 2>&1 and a captured call that asks for a listed field', () => {
    expect(flagged('live=$(aws lambda get-function-configuration --function-name f --query CodeSha256 --output text 2>&1)')).toBe(false)
    expect(flagged('aws lambda wait function-updated --function-name f\r\n')).toBe(true)
  })
})
