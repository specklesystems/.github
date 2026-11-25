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
  merged = false,
  labels = [],
  baseRef = 'main',
  fork = false,
  sha = HEAD,
  body = `Summary.\n\nReviewed at ${sha.slice(0, 7)}`
}) => ({
  number,
  state,
  merged,
  html_url: `https://github.com/o/r/pull/${number}`,
  body,
  user: { login: fork ? 'mallory' : 'alice', type: 'User' },
  labels: labels.map((name) => ({ name })),
  changed_files: 1,
  commits: 1,
  base: { ref: baseRef, repo },
  head: { sha, ref: 'b', repo: fork ? { full_name: 'mallory/r' } : repo }
})
const approvalOf = (login) => ({
  user: { login, type: 'User' },
  state: 'APPROVED',
  commit_id: HEAD,
  body: ''
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
const run = async ({ event, pulls, routes = [], context }) => {
  const statuses = []
  const requests = []
  context.mock.method(console, 'log', () => {})
  context.mock.method(
    globalThis,
    'fetch',
    async (url, { method = 'GET', body } = {}) => {
      const path = url.replace(API, '')
      requests.push(`${method} ${path}`)
      if (method !== 'GET') {
        const sent = body ? JSON.parse(body) : {}
        if (path.startsWith('/statuses/')) {
          statuses.push(`${path.slice(10, 17)} ${sent.state}: ${sent.description}`)
        }
        return response({ value: {} })
      }
      const route = routes.find(({ match }) => path.startsWith(match))
      if (route) return response({ value: route.value, status: route.status })
      const one = path.match(/^\/pulls\/(\d+)$/)
      if (one) return response({ value: pulls[one[1]] })
      if (path.startsWith('/pulls?')) {
        const query = new URLSearchParams(path.split('?')[1])
        const head = query.get('head')
        const listed = Object.values(pulls).filter(
          (listedPull) =>
            (query.get('state') === 'all' || listedPull.state === 'open') &&
            (!head ||
              `${listedPull.head.repo.full_name.split('/')[0]}:${listedPull.head.ref}` ===
                head)
        )
        return response({ value: listed })
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
  return { statuses, requests }
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

const standardRules = [
  { type: 'required_status_checks', parameters: { required_status_checks: [] } },
  { type: 'pull_request', parameters: { required_approving_review_count: 1 } }
]

describe('a review run started through workflow_run', () => {
  // GitHub names the base repo as the head repo for a review of a fork PR
  // (change-gate-sandbox#2, run 45439700183).
  const reviewRun = {
    action: 'completed',
    workflow_run: {
      head_sha: HEAD,
      head_branch: 'test/fork-case',
      head_repository: { full_name: 'o/r', owner: { login: 'o' } },
      pull_requests: []
    }
  }
  const approved = { match: '/pulls/3/reviews', value: [approvalOf('bob')] }

  it('finds a PR from a fork by its head commit', async (context) => {
    const { statuses } = await run({
      context,
      event: reviewRun,
      pulls: { 3: pull({ number: 3, fork: true }), 4: pull({ number: 4, sha: NEXT }) },
      routes: [approved]
    })
    assert.deepEqual(statuses, [
      'aaaaaaa pending: Evaluating',
      'aaaaaaa success: no color: PR from a fork, approved by bob'
    ])
  })

  it('removes review-after-merge from a merged PR from a fork on its late approval', async (context) => {
    const { requests } = await run({
      context,
      event: reviewRun,
      pulls: {
        3: pull({
          number: 3,
          fork: true,
          state: 'closed',
          merged: true,
          labels: ['review-after-merge']
        })
      },
      routes: [
        approved,
        { match: '/rules/branches/main', value: standardRules },
        {
          match: `/commits/${HEAD}`,
          value: { author: { login: 'mallory' }, committer: { login: 'mallory' } }
        }
      ]
    })
    assert.ok(requests.includes('DELETE /issues/3/labels/review-after-merge'))
  })

  it('evaluates both PRs that share the head commit', async (context) => {
    const { statuses } = await run({
      context,
      event: reviewRun,
      pulls: { 3: pull({ number: 3 }), 9: pull({ number: 9, fork: true }) }
    })
    assert.deepEqual(statuses, [
      'aaaaaaa pending: Evaluating',
      'aaaaaaa failure: aaaaaaa is also the head of #9; open one PR per commit',
      'aaaaaaa pending: Evaluating',
      'aaaaaaa failure: aaaaaaa is also the head of #3; open one PR per commit'
    ])
  })
})

describe('a merge', () => {
  const closed = { action: 'closed', pull_request: { number: 3 } }
  const mergedPull = (overrides = {}) =>
    pull({ number: 3, state: 'closed', merged: true, ...overrides })
  const pushedBy = (login) => ({
    match: '/activity?ref=b',
    value: [
      {
        activity_type: 'branch_deletion',
        after: '0'.repeat(40),
        actor: { login: 'alice' }
      },
      { activity_type: 'push', after: HEAD, actor: { login } }
    ]
  })
  const labelled = (requests) => requests.includes('POST /issues/3/labels')

  it('without an approval, into a branch that requires one, gets review-after-merge', async (context) => {
    const { requests } = await run({
      context,
      event: closed,
      pulls: { 3: mergedPull() },
      routes: [
        { match: '/rules/branches/main', value: standardRules },
        pushedBy('alice')
      ]
    })
    assert.ok(labelled(requests))
  })

  it('with an approval of another engineer gets no label', async (context) => {
    const { requests } = await run({
      context,
      event: closed,
      pulls: { 3: mergedPull() },
      routes: [
        { match: '/pulls/3/reviews', value: [greenReview, approvalOf('bob')] },
        { match: '/rules/branches/main', value: standardRules },
        pushedBy('alice')
      ]
    })
    assert.ok(!labelled(requests))
  })

  it('approved only by the person who pushed last gets the label', async (context) => {
    const { requests } = await run({
      context,
      event: closed,
      pulls: { 3: mergedPull() },
      routes: [
        { match: '/pulls/3/reviews', value: [greenReview, approvalOf('bob')] },
        { match: '/rules/branches/main', value: standardRules },
        pushedBy('bob')
      ]
    })
    assert.ok(labelled(requests))
  })

  it('takes the head commit author when the push is not in the activity list', async (context) => {
    for (const [author, expected] of [
      ['bob', true],
      ['alice', false]
    ]) {
      const { requests } = await run({
        context,
        event: closed,
        pulls: { 3: mergedPull() },
        routes: [
          { match: '/pulls/3/reviews', value: [greenReview, approvalOf('bob')] },
          { match: '/rules/branches/main', value: standardRules },
          { match: '/activity', value: { message: 'Forbidden' }, status: 403 },
          {
            match: `/commits/${HEAD}`,
            value: { author: { login: author }, committer: { login: 'web-flow' } }
          }
        ]
      })
      assert.equal(labelled(requests), expected, author)
    }
  })

  it('gets the label when the check cannot read the rules of the branch', async (context) => {
    const { requests } = await run({
      context,
      event: closed,
      pulls: { 3: mergedPull() },
      routes: [
        { match: '/pulls/3/reviews', value: [greenReview, approvalOf('bob')] },
        {
          match: '/rules/branches/main',
          value: { message: 'Bad Gateway' },
          status: 502
        },
        pushedBy('alice')
      ]
    })
    assert.ok(labelled(requests))
  })

  it('into a branch that requires no approval gets no label', async (context) => {
    const { requests } = await run({
      context,
      event: closed,
      pulls: { 3: mergedPull() },
      routes: [
        { match: '/rules/branches/main', value: [standardRules[0]] },
        pushedBy('alice')
      ]
    })
    assert.ok(!labelled(requests))
  })
})

describe('the code review line', () => {
  const BEFORE = 'd'.repeat(40)
  const BASE_TIP = 'e'.repeat(40)
  const traced = (aheadBy) => [
    {
      match: '/pulls/3/commits',
      value: [
        { sha: SOURCE, parents: [{ sha: BEFORE }] },
        { sha: HEAD, parents: [{ sha: SOURCE }, { sha: BASE_TIP }] }
      ]
    },
    { match: `/compare/main...${BASE_TIP}`, value: { ahead_by: aheadBy } }
  ]
  const opened = { action: 'opened', pull_request: { number: 3 } }
  const earlier = pull({ number: 3, body: `Reviewed at ${SOURCE.slice(0, 7)}` })

  it('passes on an earlier commit followed by a merge from the base branch', async (context) => {
    const { statuses } = await run({
      context,
      event: opened,
      pulls: { 3: earlier },
      routes: traced(0)
    })
    assert.equal(statuses.at(-1), 'aaaaaaa success: green')
  })

  it('fails on an earlier commit followed by a merge of another branch', async (context) => {
    const { statuses } = await run({
      context,
      event: opened,
      pulls: { 3: earlier },
      routes: traced(2)
    })
    assert.equal(
      statuses.at(-1),
      'aaaaaaa failure: The description ends with "Reviewed at ccccccc"; the newest commit is aaaaaaa. ' +
        'Review it, then end with "Reviewed at aaaaaaa"'
    )
  })

  it('reads no commit when the line names the head, or for a PR from a fork', async (context) => {
    for (const pulls of [
      { 3: pull({ number: 3 }) },
      { 3: pull({ number: 3, fork: true, body: `Reviewed at ${SOURCE.slice(0, 7)}` }) }
    ]) {
      const { requests } = await run({ context, event: opened, pulls })
      assert.deepEqual(
        requests.filter((request) => /\/commits|\/compare/.test(request)),
        []
      )
    }
  })
})
