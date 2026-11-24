// Run by both workflows. Lambda's answers to update, get and publish calls
// carry the bot's keys, and this repo's Actions logs are public, so every AWS
// CLI call to lambda anywhere in .github/ must ask for exactly one listed
// field, or send its output to /dev/null. A service name held in a variable
// gets past this; review catches that.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const FIELDS = new Set(['CodeSha256', 'StatusCode', 'Code.Location', 'LastUpdateStatus', 'State'])
// AWS CLI options that take no value; every other option takes one.
const FLAGS = new Set(['--debug', '--no-verify-ssl', '--no-paginate', '--no-sign-request', '--no-cli-pager', '--no-cli-auto-prompt'])
const OPERATOR = /^(&&|\|\||&>|1>|2>|>>|[;|&>])/

// Splits a shell line into words and operators. Quoted text stays one word,
// and a # starts a comment only where a word would begin.
export function tokenize(line) {
  const tokens = []
  let word = ''
  let quoted = false
  const end = () => {
    if (word !== '' || quoted) tokens.push({ text: word, quoted })
    word = ''
    quoted = false
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'" || c === '"') {
      const close = line.indexOf(c, i + 1)
      word += close === -1 ? line.slice(i + 1) : line.slice(i + 1, close)
      quoted = true
      i = close === -1 ? line.length : close
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i]
    } else if (/\s/.test(c)) {
      end()
    } else if (c === '#' && word === '' && !quoted) {
      break
    } else if (OPERATOR.test(line.slice(i)) && !(c === '&' && word === '' && /[<>]$/.test(tokens.at(-1)?.text ?? ''))) {
      end()
      const op = line.slice(i).match(OPERATOR)[1]
      tokens.push({ text: op, op: true })
      i += op.length - 1
    } else {
      word += c
    }
  }
  end()
  return tokens
}

function lambdaCallProblem(command) {
  // `aws`, also as in `x=$(aws ...)`
  const start = command.findIndex((t) => !t.op && /(?:^|[=$(<`/])aws$/.test(t.text))
  if (start === -1) return null
  let i = start + 1
  while (i < command.length && command[i].text.startsWith('--')) i += FLAGS.has(command[i].text) || command[i].text.includes('=') ? 1 : 2
  if (command[i]?.text !== 'lambda') return null
  const words = command.slice(start)
  if (words.some((t) => t.text === '--debug')) return '--debug prints the whole answer'
  const queries = words.flatMap((t, j) => {
    if (t.text === '--query') return [words[j + 1]?.text]
    return t.text.startsWith('--query=') ? [t.text.slice('--query='.length)] : []
  })
  const captured = /[(`]aws$/.test(command[start].text)
  const outs = words.flatMap((t, j) => (t.op && ['>', '1>', '&>', '>>'].includes(t.text) ? [words[j + 1]?.text] : []))
  const quiet = !captured && outs.at(-1) === '/dev/null'
  if (queries.length === 1 && FIELDS.has(queries[0].replace(/\)+$/, ''))) return null
  if (queries.length === 0 && quiet) return null
  return 'ask for exactly one listed field with --query, or send the output to > /dev/null'
}

export function problemsIn(text, file) {
  const problems = []
  // A command continued over several lines with a trailing backslash is one call.
  for (const line of text.replace(/\r\n/g, '\n').replace(/\\\n\s*/g, ' ').split('\n')) {
    const tokens = tokenize(line)
    for (const t of tokens) if (t.quoted && /\baws\b/.test(t.text)) problems.push(...problemsIn(t.text, file))
    if (tokens.some((t) => !t.quoted && /(^|[[{,])(pull_request_target|workflow_run)([\]},:]|$)/.test(t.text))) {
      problems.push(`${file}: ${line.trim()}: runs with this repo's secrets on code others control`)
    }
    let command = []
    for (const token of [...tokens, { text: ';', op: true }]) {
      if (token.op && ['&&', '||', ';', '|', '&'].includes(token.text)) {
        const problem = lambdaCallProblem(command)
        if (problem) problems.push(`${file}: ${problem}: ${line.trim()}`)
        command = []
      } else {
        command.push(token)
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = filesUnder('.github').flatMap((file) => problemsIn(readFileSync(file, 'utf8'), file))
  for (const problem of problems) console.error(problem)
  process.exit(problems.length ? 1 : 0)
}
