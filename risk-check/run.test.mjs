import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const HEAD = 'a'.repeat(40)
const NEXT = 'b'.repeat(40)
const SOURCE = 'c'.repeat(40)
const API = 'https://api.github.com/repos/o/r'
const eventPath = join(mkdtempSync(join(tmpdir(), 'risk-check-')), 'event.json')
Object.assign(process.env, {
  GITHUB_TOKEN: 'token',
  GITHUB_REPOSITORY: 'o/r',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '1',
  GITHUB_EVENT_PATH: eventPath
})

const repo = { full_name: 'o/r', default_branch: 'main' }
const pull = ({
  number,
  state = 'open',
  baseRef = 'main',
  fork = false,
  sha = HEAD
}) => ({
  number,
  state,
  merged: false,
  html_url: `https://github.com/o/r/pull/${number}`,
  user: { login: fork ? 'mallory' : 'alice', type: 'User' },
  labels: [],
  changed_files: 1,
  commits: 1,
  base: { ref: baseRef, repo },
  head: { sha, ref: 'b', repo: fork ? { full_name: 'mallory/r' } : repo }
})
const greenReview = {
  user: { login: 'alice' },
  state: 'COMMENTED',
  commit_id: HEAD,
  body: `Approver result for commit ${HEAD.slice(0, 7)}: green\n\nNo findings.`
}
const response = ({ value, status = 200 }) => ({
  ok: status < 400,
  status,
  json: async () => value,
  text: async () => (typeof value === 'string' ? value : JSON.stringify(value))
})

let runs = 0
// run.mjs works on import, so each case imports it again under a new URL.
const run = async ({ event, pulls, routes = [], commentStatus = 200, context }) => {
  const statuses = []
  const requests = []
  const comments = []
  context.mock.method(console, 'log', () => {})
  context.mock.method(console, 'error', () => {})
  context.mock.method(
    globalThis,
    'fetch',
    async (url, { method = 'GET', body } = {}) => {
      const path = url.replace(API, '')
      requests.push(`${method} ${path}`)
      if (method !== 'GET') {
        const sent = JSON.parse(body)
        if (path.startsWith('/statuses/')) {
          statuses.push(`${path.slice(10, 17)} ${sent.state}: ${sent.description}`)
        }
        if (path.endsWith('/comments')) {
          comments.push(sent)
          return response({ value: {}, status: commentStatus })
        }
        return response({ value: {} })
      }
      const route = routes.find(({ match }) => path.startsWith(match))
      if (route) return response({ value: route.value, status: route.status })
      const one = path.match(/^\/pulls\/(\d+)$/)
      if (one) return response({ value: pulls[one[1]] })
      if (path.startsWith('/pulls?')) {
        const open = Object.values(pulls).filter(({ state }) => state === 'open')
        return response({ value: open })
      }
      if (path.includes('/files?'))
        return response({ value: [{ filename: 'src/a.ts' }] })
      if (path.includes('/reviews?')) return response({ value: [greenReview] })
      if (path.includes('/permission'))
        return response({ value: { permission: 'write' } })
      if (path.includes('/comments?')) return response({ value: [] })
      return response({ value: { message: 'Not Found' }, status: 404 })
    }
  )
  writeFileSync(eventPath, JSON.stringify(event))
  await import(`./run.mjs?run=${++runs}`)
  return { statuses, requests, comments }
}

describe('two open PRs with one head commit', () => {
  const failed =
    'aaaaaaa failure: aaaaaaa is also the head of #9; open one PR per commit'
  const own = ['aaaaaaa pending: Evaluating', 'aaaaaaa success: green']

  it('both fail, and the status names the copy', async (context) => {
    const { statuses } = await run({
      context,
      event: { action: 'opened', pull_request: { number: 3 } },
      pulls: { 3: pull({ number: 3 }), 9: pull({ number: 9, fork: true }) }
    })
    assert.deepEqual(statuses, ['aaaaaaa pending: Evaluating', failed])
  })

  it('the other PR gets its own result back when the copy closes', async (context) => {
    const { statuses } = await run({
      context,
      event: { action: 'closed', pull_request: { number: 9 } },
      pulls: {
        3: pull({ number: 3 }),
        9: pull({ number: 9, state: 'closed', fork: true })
      }
    })
    assert.deepEqual(statuses, own)
  })

  it('the other PR gets its own result back when the copy gets a new commit', async (context) => {
    const { statuses } = await run({
      context,
      event: { action: 'synchronize', before: HEAD, pull_request: { number: 9 } },
      pulls: { 3: pull({ number: 3 }), 9: pull({ number: 9, fork: true, sha: NEXT }) }
    })
    assert.deepEqual(statuses.slice(-2), own)
  })

  it('a PR into a branch the check does not cover is not a copy', async (context) => {
    const { statuses } = await run({
      context,
      event: { action: 'opened', pull_request: { number: 3 } },
      pulls: { 3: pull({ number: 3 }), 9: pull({ number: 9, baseRef: 'alice/stack' }) }
    })
    assert.deepEqual(statuses, own)
  })
})

describe('a PR into a hotfix branch', () => {
  const patch = '@@ -1,2 +1,3 @@\n context\n+added'
  const commit = {
    parents: [{}],
    files: [{ filename: 'src/a.ts', status: 'modified', patch }]
  }
  const requiresRiskCheck = [
    {
      type: 'required_status_checks',
      parameters: { required_status_checks: [{ context: 'risk-check' }] }
    }
  ]
  const hotfix = (overrides) => ({
    ...pull({ number: 3, baseRef: 'hotfix-1' }),
    ...overrides
  })

  it('is green with no approver color when its commit copies a commit on main', async (context) => {
    const { statuses } = await run({
      context,
      event: { action: 'opened', pull_request: { number: 3 } },
      pulls: { 3: hotfix() },
      routes: [
        { match: '/pulls/3/reviews', value: [] },
        {
          match: '/pulls/3/commits',
          value: [
            {
              sha: HEAD,
              commit: { message: `fix\n\n(cherry picked from commit ${SOURCE})` }
            }
          ]
        },
        { match: '/rules/branches/main', value: requiresRiskCheck },
        { match: `/compare/${SOURCE}...main`, value: { status: 'ahead' } },
        { match: '/commits/', value: commit }
      ]
    })
    assert.equal(
      statuses.at(-1),
      'aaaaaaa success: green: moves changes that already merged'
    )
  })

  it('follows the normal rules, and compares no commit, past 20 commits', async (context) => {
    const { statuses, requests } = await run({
      context,
      event: { action: 'opened', pull_request: { number: 3 } },
      pulls: { 3: hotfix({ commits: 21 }) },
      routes: [{ match: '/pulls/3/reviews', value: [] }]
    })
    assert.match(statuses.at(-1), /failure: No approver color/)
    assert.deepEqual(
      requests.filter((request) => /\/commits|\/compare|\/rules/.test(request)),
      []
    )
  })
})

describe('a PR that changes the floors file', () => {
  it('fails on a line the check cannot read in the file at its head', async (context) => {
    const { statuses } = await run({
      context,
      event: { action: 'opened', pull_request: { number: 3 } },
      pulls: { 3: pull({ number: 3 }) },
      routes: [
        {
          match: '/pulls/3/files',
          value: [{ filename: '.github/risk-floors.yml', status: 'modified' }]
        },
        {
          match: `/contents/.github/risk-floors.yml?ref=${HEAD}`,
          value: 'yellow:\n  src/**\n'
        }
      ]
    })
    assert.equal(
      statuses.at(-1),
      'aaaaaaa failure: This PR breaks the floors file: .github/risk-floors.yml line 2: ' +
        'expected one of "yellow:", "red:", "bots:" or "  - <value>"'
    )
  })

  it('fails, also with the emergency label, when GitHub does not return that file', async (context) => {
    const { statuses } = await run({
      context,
      event: { action: 'opened', pull_request: { number: 3 } },
      pulls: { 3: { ...pull({ number: 3 }), labels: [{ name: 'emergency' }] } },
      routes: [
        {
          match: '/pulls/3/files',
          value: [{ filename: '.github/risk-floors.yml', status: 'modified' }]
        },
        {
          match: `/contents/.github/risk-floors.yml?ref=${HEAD}`,
          value: { message: 'Bad Gateway' },
          status: 502
        }
      ]
    })
    assert.equal(
      statuses.at(-1),
      'aaaaaaa failure: The check could not read the floors file of this PR (HTTP 502); run it again'
    )
  })
})

describe('a PR that changes a path of the floors file', () => {
  const yellowReview = {
    ...greenReview,
    body: `Approver result for commit ${HEAD.slice(0, 7)}: yellow\n\nMinimum color for agent configuration.`
  }
  const changed = [
    { filename: 'AGENTS.md', status: 'modified' },
    { filename: 'docs/agents/b.md', previous_filename: 'docs/agents/a.md', status: 'renamed' },
    { filename: 'src/a.ts', status: 'modified' }
  ]
  const routes = (comments) => [
    { match: '/pulls/3/files', value: changed },
    { match: '/pulls/3/reviews', value: [yellowReview] },
    { match: '/pulls/3/comments', value: comments },
    {
      match: '/contents/.github/risk-floors.yml?ref=main',
      value: 'yellow:\n  - AGENTS.md\n  - docs/agents/**\n'
    }
  ]

  it('gets one floor comment on each floor path when the approver color meets the floor', async (context) => {
    const { statuses, comments } = await run({
      context,
      event: { action: 'opened', pull_request: { number: 3 } },
      pulls: { 3: pull({ number: 3 }) },
      routes: routes([])
    })
    assert.equal(statuses.at(-1), 'aaaaaaa success: yellow: resolve each finding before the merge')
    assert.deepEqual(
      comments.map(({ path }) => path),
      ['AGENTS.md', 'docs/agents/b.md']
    )
  })

  it('gets no second floor comment on a later run', async (context) => {
    const existing = ['AGENTS.md', 'docs/agents/b.md'].map((path) => ({
      user: { login: 'github-actions[bot]' },
      body: `<!-- risk-floor:${path} -->\n**Minimum color yellow:** …`
    }))
    const { comments } = await run({
      context,
      event: { action: 'synchronize', pull_request: { number: 3 } },
      pulls: { 3: pull({ number: 3 }) },
      routes: routes(existing)
    })
    assert.deepEqual(comments, [])
  })

  it('keeps a broken floors file a failure, also with the emergency label, when GitHub refuses the floor comment', async (context) => {
    const { statuses } = await run({
      context,
      event: { action: 'opened', pull_request: { number: 3 } },
      pulls: { 3: { ...pull({ number: 3 }), labels: [{ name: 'emergency' }] } },
      commentStatus: 422,
      routes: [
        {
          match: '/pulls/3/files',
          value: [{ filename: '.github/risk-floors.yml', status: 'modified' }]
        },
        {
          match: `/contents/.github/risk-floors.yml?ref=${HEAD}`,
          value: 'yellow:\n  src/**\n'
        }
      ]
    })
    assert.equal(
      statuses.at(-1),
      'aaaaaaa failure: This PR breaks the floors file: .github/risk-floors.yml line 2: ' +
        'expected one of "yellow:", "red:", "bots:" or "  - <value>"'
    )
  })
})
