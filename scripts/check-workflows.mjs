// Run by test.yml. Lambda's answers to update, publish and get calls carry the
// bot's keys, and this repo's Actions logs are public, so every `aws lambda`
// call in a workflow must print only the field it asks for, or nothing.
import { readdirSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function problemsIn(text, file) {
  const problems = []
  // A command continued over several lines with a trailing backslash is one call.
  text.replace(/\\\n\s*/g, ' ').split('\n').forEach((line, i) => {
    if (/\baws lambda\b/.test(line) && !/--query|>\s*\/dev\/null/.test(line)) {
      problems.push(`${file}: an aws lambda call prints its whole answer: ${line.trim()}`)
    }
    if (/\bpull_request_target\b/.test(line)) {
      problems.push(`${file}: pull_request_target runs a fork's code with this repo's secrets`)
    }
  })
  return problems
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = '.github/workflows'
  const problems = readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) => problemsIn(readFileSync(`${dir}/${file}`, 'utf8'), file))
  for (const problem of problems) console.error(problem)
  process.exit(problems.length ? 1 : 0)
}
