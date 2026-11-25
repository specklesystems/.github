import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const HEAD = 'a'.repeat(40)
const API = 'https://api.github.com/repos/o/r'
Object.assign(process.env, {
  GITHUB_TOKEN: 'token',
  GITHUB_REPOSITORY: 'o/r',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '1',
  HEAD_SHA: HEAD
})

const repo = { full_name: 'o/r' }
const pull = ({
  number = 3,
  sha = HEAD,
  fork = false,
  labels = ['emergency'],
  changedFiles = 1,
  body = `Summary.\n\nReviewed at ${HEAD.slice(0, 7)}`
} = {}) => ({
  number,
  body,
  changed_files: changedFiles,
  labels: labels.map((name) => ({ name })),
  head: { sha, repo: fork ? { full_name: 'mallory/r' } : repo }
})
const response = ({ value, status = 200 }) => ({
  ok: status < 400,
  status,
  json: async () => value,
  text: async () => JSON.stringify(value)
})

let runs = 0
// failed-run.mjs works on import, so each case imports it again under a new URL.
const run = async ({ pulls, files = {}, context }) => {
  const printed = []
  context.mock.method(console, 'log', (line) => printed.push(line))
  context.mock.method(globalThis, 'fetch', async (url) => {
    const path = url.replace(API, '')
    const listed = path.match(/^\/pulls\/(\d+)\/files\?/)
    if (listed) {
      const value = files[listed[1]] ?? [{ filename: 'src/a.ts' }]
      return value.status ? response(value) : response({ value })
    }
    const one = path.match(/^\/pulls\/(\d+)$/)
    if (one)
      return response({ value: pulls.find(({ number }) => `${number}` === one[1]) })
    if (path.startsWith('/pulls?')) {
      // The list of PRs carries no changed_files; only GET /pulls/{n} does.
      return response({ value: pulls.map(({ changed_files, ...listed }) => listed) })
    }
    return response({ value: { message: 'Not Found' }, status: 404 })
  })
  await import(`./failed-run.mjs?run=${++runs}`)
  return printed.join('\n')
}

describe('a failed run', () => {
  it('passes a PR from this repo with the emergency label', async (context) => {
    assert.equal(await run({ context, pulls: [pull()] }), 'true')
  })

  it('passes no PR whose description does not end with "Reviewed at" the head', async (context) => {
    for (const body of ['Summary.', `Reviewed at ${'b'.repeat(7)}`, null]) {
      assert.equal(await run({ context, pulls: [pull({ body })] }), 'false', body)
    }
  })

  it('passes no PR without the emergency label', async (context) => {
    assert.equal(await run({ context, pulls: [pull({ labels: [] })] }), 'false')
  })

  it('passes no PR from a fork', async (context) => {
    assert.equal(await run({ context, pulls: [pull({ fork: true })] }), 'false')
  })

  it('passes nothing when no open PR has the head commit', async (context) => {
    assert.equal(
      await run({ context, pulls: [pull({ sha: 'b'.repeat(40) })] }),
      'false'
    )
  })

  it('passes no PR when another PR with the same head does not qualify', async (context) => {
    const pulls = [pull(), pull({ number: 4, fork: true })]
    assert.equal(await run({ context, pulls }), 'false')
  })

  it('passes no PR that changes the floors file', async (context) => {
    for (const changed of [
      { filename: '.github/risk-floors.yml', status: 'modified' },
      { filename: '.github/risk-floors.yml', status: 'removed' },
      {
        filename: 'old.yml',
        previous_filename: '.github/risk-floors.yml',
        status: 'renamed'
      }
    ]) {
      const files = { 3: [{ filename: 'src/a.ts' }, changed] }
      assert.equal(
        await run({ context, pulls: [pull({ changedFiles: 2 })], files }),
        'false'
      )
    }
  })

  it('passes no PR whose changed files it cannot read', async (context) => {
    const files = { 3: { value: { message: 'Bad Gateway' }, status: 502 } }
    assert.equal(await run({ context, pulls: [pull()], files }), 'false')
  })

  it('passes no PR whose changed files GitHub does not list in full', async (context) => {
    assert.equal(await run({ context, pulls: [pull({ changedFiles: 2 })] }), 'false')
  })
})
