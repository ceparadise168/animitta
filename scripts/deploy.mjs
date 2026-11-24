// Deploys the whole stack from this computer: npm run deploy (extra arguments
// go to cdk deploy). It refuses anything but the latest main with nothing
// uncommitted, because GitHub Actions also deploys lambda/ from main, and an
// older checkout would put back code that main has already fixed. Afterwards
// it records what runs (/animitta/deployed) and runs the bot's self-test.
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REGION = 'ap-northeast-1'
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()
const git = (...args) => run('git', args)

git('fetch', '--quiet', 'origin', 'main')
const problems = []
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') problems.push('this is not main')
if (git('status', '--porcelain')) problems.push('there are uncommitted changes')
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) problems.push('this is not the latest origin/main (git pull first)')
if (problems.length) {
  console.error(`Refusing to deploy: ${problems.join('; ')}.`)
  process.exit(1)
}

execFileSync('npx', ['cdk', 'deploy', ...process.argv.slice(2)], { stdio: 'inherit' })

// The automatic deploy compares these trees, to refuse while cdk/ or ops/
// on main differ from what this deploy put up.
const commit = git('rev-parse', 'HEAD')
const infraTree = `${git('rev-parse', 'HEAD:cdk')} ${git('rev-parse', 'HEAD:ops')}`
const marker = JSON.stringify({ commit, infraTree, at: new Date().toISOString(), by: 'npm run deploy' })
run('aws', ['ssm', 'put-parameter', '--region', REGION, '--name', '/animitta/deployed', '--type', 'String', '--overwrite', '--value', marker, '--query', 'Version', '--output', 'text'])
console.log(`Recorded ${commit.slice(0, 7)} as what runs.`)

const out = join(mkdtempSync(join(tmpdir(), 'animitta-')), 'self-test.json')
run('aws', ['lambda', 'invoke', '--region', REGION, '--function-name', 'animitta', '--cli-binary-format', 'raw-in-base64-out', '--payload', '{"selfTest":true}', out, '--query', 'StatusCode', '--output', 'text'])
const result = JSON.parse(JSON.parse(readFileSync(out, 'utf8')).body)
console.log('Self-test:', result)
if (result.anthropic !== 'ok' || result.signature !== 'ok' || !['ok', 'off'].includes(result.bedrock)) {
  console.error('The self-test failed: the deploy is live, so look at it now.')
  process.exit(1)
}
