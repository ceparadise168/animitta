// Deploys the whole stack from this computer: npm run deploy (extra arguments
// go to cdk deploy). It refuses anything but exactly the latest main, because
// GitHub Actions also deploys lambda/ from main, and anything else would put
// back code that main has already fixed. Afterwards it records what runs
// (/animitta/deployed) and runs the bot's self-test.
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REGION = 'ap-northeast-1'
const FUNCTION = 'animitta'
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()
const git = (...args) => run('git', args)
const cdkArgs = process.argv.slice(2)

git('fetch', '--quiet', 'origin', 'main')
const problems = []
if (!/^(https:\/\/github\.com\/|git@github\.com:)ceparadise168\/animitta(\.git)?$/.test(git('remote', 'get-url', 'origin'))) problems.push('origin is not github.com/ceparadise168/animitta')
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') problems.push('this is not main')
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) problems.push('this is not the latest origin/main (git pull first)')
if (git('status', '--porcelain')) problems.push('there are uncommitted changes')
// Ignored files count too where cdk packs folders as they lie.
if (git('status', '--porcelain', '--ignored', '--untracked-files=all', '--', 'lambda', 'ops', 'cdk')) problems.push('lambda/, ops/ or cdk/ hold ignored files')
if (git('ls-files', '-v').split('\n').some((line) => /^[a-zS] /.test(line))) problems.push('some files are marked assume-unchanged or skip-worktree')
if (cdkArgs.some((arg) => arg === '-a' || arg.startsWith('--app'))) problems.push('--app would deploy something other than this checkout')
if (problems.length) {
  console.error(`Refusing to deploy: ${problems.join('; ')}.`)
  process.exit(1)
}

execFileSync('npx', ['cdk', 'deploy', ...cdkArgs], { stdio: 'inherit' })

const aws = (...args) => run('aws', ['--region', REGION, ...args])
// What GitHub Actions compares before deploying: the commit, the cdk/ and ops/
// trees this put up, and the code Lambda holds.
const marker = {
  commit: git('rev-parse', 'HEAD'),
  infraTree: `${git('rev-parse', 'HEAD:cdk')} ${git('rev-parse', 'HEAD:ops')}`,
  codeSha256: aws('lambda', 'get-function-configuration', '--function-name', FUNCTION, '--query', 'CodeSha256', '--output', 'text'),
  at: new Date().toISOString(),
  by: 'npm run deploy',
}
aws('ssm', 'put-parameter', '--name', '/animitta/deployed', '--type', 'String', '--overwrite', '--value', JSON.stringify(marker), '--query', 'Version', '--output', 'text')
console.log(`Recorded ${marker.commit.slice(0, 7)} as what runs.`)

const out = join(mkdtempSync(join(tmpdir(), 'animitta-')), 'self-test.json')
aws('lambda', 'invoke', '--function-name', FUNCTION, '--cli-binary-format', 'raw-in-base64-out', '--payload', '{"selfTest":true}', out, '--query', 'StatusCode', '--output', 'text')
const result = JSON.parse(JSON.parse(readFileSync(out, 'utf8')).body)
console.log('Self-test:', result)
const answers = result.anthropic === 'ok' || result.bedrock === 'ok'
// The model for worries has no stand-in at deploy time: failing, every worry would go to the chat model unnoticed.
const worriesAnswered = ['ok', 'off'].includes(result.worries)
if (result.signature !== 'ok' || !answers || !worriesAnswered) {
  console.error('The self-test failed: the deploy is live, so look at it now.')
  process.exit(1)
}
if (result.anthropic !== 'ok' || !['ok', 'off'].includes(result.bedrock)) console.warn('One way to answer is down; the bot still answers through the other.')
