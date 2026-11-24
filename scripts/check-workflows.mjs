// Run by both workflows. Lambda's answers to update, get and publish calls
// carry the bot's keys, and this repo's Actions logs are public, so every AWS
// CLI call to lambda anywhere in .github/ must ask for one listed field, or
// send its output to /dev/null. A service name held in a variable gets past
// this; review catches that.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const FIELDS = new Set(['CodeSha256', 'StatusCode', 'Code.Location', 'LastUpdateStatus', 'State'])

export function problemsIn(text, file) {
  const problems = []
  // A command continued over several lines with a trailing backslash is one call.
  for (const raw of text.replace(/\\\n\s*/g, ' ').split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '')
    if (/\b(pull_request_target|workflow_run)\b/.test(line)) {
      problems.push(`${file}: ${line.trim()}: runs with this repo's secrets on code others control`)
    }
    for (const command of line.split(/&&|\|\||[;|]/)) {
      if (!/\baws\b/.test(command) || !/\slambda\s/.test(` ${command} `)) continue
      const field = command.match(/--query[=\s]+['"]?([^\s'"]+)/)?.[1]
      const quiet = /(^|[^0-9&>])>\s*\/dev\/null|&>\s*\/dev\/null/.test(command)
      if (/--debug\b/.test(command) || !(FIELDS.has(field) || quiet)) {
        problems.push(`${file}: this aws lambda call can print the bot's keys: ${command.trim()}`)
      }
    }
  }
  return problems
}

const filesUnder = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = filesUnder('.github').flatMap((file) => problemsIn(readFileSync(file, 'utf8'), file))
  for (const problem of problems) console.error(problem)
  process.exit(problems.length ? 1 : 0)
}
