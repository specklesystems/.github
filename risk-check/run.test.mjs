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
// run.mjs works on import, so each case imports it again under a new URL. A case
// that expects the run to fail sets `throws`, and gets the error back.
const run = async ({ event, pulls, routes = [], context, throws = false }) => {
  const statuses = []
  const requests = []
  const labels = []
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
        if (method === 'POST' && /^\/issues\/\d+\/labels$/.test(path)) {
          labels.push(...sent.labels)
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
  const imported = import(`./run.mjs?run=${++runs}`)
  if (!throws) {
    await imported
    return { statuses, requests, labels }
  }
  const error = await imported.then(
    () => assert.fail('the run did not fail'),
    (thrown) => thrown
  )
  return { statuses, requests, labels, error }
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

const LABEL = 'review-after-merge'
const standardRules = [
  { type: 'required_status_checks', parameters: { required_status_checks: [] } },
  { type: 'pull_request', parameters: { required_approving_review_count: 1 } }
]
const rulesOfMain = (value, status) => ({
  match: '/rules/branches/main',
  value,
  status
})
const reviewsOf3 = (...value) => ({ match: '/pulls/3/reviews', value })
const failing = (match) => ({ match, value: { message: 'Bad Gateway' }, status: 502 })
const mergedPull = (overrides = {}) =>
  pull({ number: 3, state: 'closed', merged: true, ...overrides })

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
  const approved = reviewsOf3(approvalOf('bob'))
  const listPage = (page) =>
    `/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`

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

  it('reads the next page of PRs when the first holds no match', async (context) => {
    const others = Array.from({ length: 100 }, (_, index) =>
      pull({ number: 100 + index, sha: NEXT })
    )
    const { statuses, requests } = await run({
      context,
      event: reviewRun,
      pulls: { 3: pull({ number: 3, fork: true }) },
      routes: [
        approved,
        { match: listPage(1), value: others },
        { match: listPage(2), value: [pull({ number: 3, fork: true })] },
        { match: '/pulls?state=all', value: others }
      ]
    })
    assert.equal(
      statuses.at(-1),
      'aaaaaaa success: no color: PR from a fork, approved by bob'
    )
    assert.ok(!requests.includes(`GET ${listPage(3)}`))
  })

  it('keeps a closed match and reads on to the first page with an open one', async (context) => {
    const others = Array.from({ length: 99 }, (_, index) =>
      pull({ number: 100 + index, sha: NEXT })
    )
    const closedCopy = pull({ number: 5, state: 'closed' })
    const { statuses, requests } = await run({
      context,
      event: reviewRun,
      pulls: { 3: pull({ number: 3, fork: true }), 5: closedCopy },
      routes: [
        approved,
        { match: listPage(1), value: [...others, closedCopy] },
        { match: listPage(2), value: [pull({ number: 3, fork: true })] },
        { match: '/pulls?state=all', value: [...others, closedCopy] }
      ]
    })
    assert.ok(requests.includes('GET /pulls/5'))
    assert.equal(
      statuses.at(-1),
      'aaaaaaa success: no color: PR from a fork, approved by bob'
    )
    assert.ok(!requests.includes(`GET ${listPage(3)}`))
  })

  it('reads on past an open match on a branch the check does not cover', async (context) => {
    const others = Array.from({ length: 99 }, (_, index) =>
      pull({ number: 100 + index, sha: NEXT })
    )
    const stacked = pull({ number: 5, baseRef: 'alice/stack' })
    const { statuses, requests } = await run({
      context,
      event: reviewRun,
      pulls: { 3: pull({ number: 3, fork: true }), 5: stacked },
      routes: [
        approved,
        { match: listPage(1), value: [...others, stacked] },
        { match: listPage(2), value: [pull({ number: 3, fork: true })] },
        { match: '/pulls?state=all', value: [...others, stacked] }
      ]
    })
    assert.ok(requests.includes(`GET ${listPage(2)}`))
    assert.equal(
      statuses.at(-1),
      'aaaaaaa success: no color: PR from a fork, approved by bob'
    )
  })

  it('fails the run, and names the head commit, when 10 full pages hold no match', async (context) => {
    const others = Array.from({ length: 100 }, (_, index) =>
      pull({ number: 100 + index, sha: NEXT })
    )
    const { requests, error } = await run({
      context,
      throws: true,
      event: reviewRun,
      pulls: {},
      routes: [{ match: '/pulls?state=all', value: others }]
    })
    assert.match(error.message, new RegExp(HEAD))
    assert.ok(requests.includes(`GET ${listPage(10)}`))
    assert.ok(!requests.includes(`GET ${listPage(11)}`))
  })

  it('removes review-after-merge from a merged PR from a fork on its late approval', async (context) => {
    const { requests, labels } = await run({
      context,
      event: reviewRun,
      pulls: { 3: mergedPull({ fork: true, labels: [LABEL] }) },
      routes: [approved, rulesOfMain(standardRules)]
    })
    assert.ok(requests.includes(`DELETE /issues/3/labels/${LABEL}`))
    assert.deepEqual(labels, [])
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
  const merging = ({ context, routes }) =>
    run({ context, event: closed, pulls: { 3: mergedPull() }, routes })

  it('without an approval, into a branch that requires one, gets review-after-merge', async (context) => {
    const { labels } = await merging({
      context,
      routes: [rulesOfMain(standardRules)]
    })
    assert.deepEqual(labels, [LABEL])
  })

  it('with an approval of another engineer gets no label', async (context) => {
    const { labels } = await merging({
      context,
      routes: [reviewsOf3(greenReview, approvalOf('bob')), rulesOfMain(standardRules)]
    })
    assert.deepEqual(labels, [])
  })

  it('takes the highest count of the pull_request rules of the branch', async (context) => {
    const { labels } = await merging({
      context,
      routes: [
        reviewsOf3(greenReview, approvalOf('bob')),
        rulesOfMain([
          ...standardRules,
          { type: 'pull_request', parameters: { required_approving_review_count: 2 } }
        ])
      ]
    })
    assert.deepEqual(labels, [LABEL])
  })

  it('gets the label when the check cannot read the rules of the branch', async (context) => {
    const { labels } = await merging({
      context,
      routes: [
        reviewsOf3(greenReview, approvalOf('bob')),
        failing('/rules/branches/main')
      ]
    })
    assert.deepEqual(labels, [LABEL])
  })

  it('into a branch that requires no approval gets no label', async (context) => {
    const { labels } = await merging({
      context,
      routes: [rulesOfMain([standardRules[0]])]
    })
    assert.deepEqual(labels, [])
  })

  it('from an author without write access, approved once, gets no label and settles one later', async (context) => {
    const routes = [
      { match: '/collaborators/alice/permission', value: { permission: 'read' } },
      reviewsOf3({ ...greenReview, user: { login: 'bob' } }, approvalOf('bob')),
      rulesOfMain(standardRules)
    ]
    const atMerge = await merging({ context, routes })
    assert.deepEqual(atMerge.labels, [])
    const later = await run({
      context,
      event: { action: 'edited', pull_request: { number: 3 } },
      pulls: { 3: mergedPull({ labels: [LABEL] }) },
      routes
    })
    assert.ok(later.requests.includes(`DELETE /issues/3/labels/${LABEL}`))
  })
})

describe('a merged PR on a later event', () => {
  const edited = { action: 'edited', pull_request: { number: 3 } }

  it('without the label is not evaluated', async (context) => {
    const { requests } = await run({
      context,
      event: edited,
      pulls: { 3: mergedPull() }
    })
    assert.deepEqual(requests, ['GET /pulls/3'])
  })

  it('keeps a label added by mistake until an approval', async (context) => {
    const { labels, requests } = await run({
      context,
      event: edited,
      pulls: { 3: mergedPull({ labels: [LABEL] }) },
      routes: [rulesOfMain([standardRules[0]])]
    })
    assert.deepEqual(labels, [])
    assert.ok(!requests.some((request) => request.startsWith('DELETE')))
  })
})

describe('the code review line', () => {
  const BEFORE = 'd'.repeat(40)
  const BASE_TIP = 'e'.repeat(40)
  const merges = (count, last = HEAD) =>
    Array.from({ length: count }, (_, index) => ({
      sha: index === count - 1 ? last : `${index}`.padStart(40, '1'),
      parents: [{ sha: BEFORE }, { sha: BASE_TIP }]
    }))
  const commitsOf3 = (...later) => ({
    match: '/pulls/3/commits',
    value: [{ sha: SOURCE, parents: [{ sha: BEFORE }] }, ...later]
  })
  const traced = (aheadBy) => [
    commitsOf3(...merges(1)),
    { match: `/compare/main...${BASE_TIP}`, value: { ahead_by: aheadBy } }
  ]
  const opened = { action: 'opened', pull_request: { number: 3 } }
  const line = `Reviewed at ${SOURCE.slice(0, 7)}`
  const earlier = pull({ number: 3, body: line })
  const oldLine =
    'aaaaaaa failure: The description ends with "Reviewed at ccccccc"; the newest commit is aaaaaaa. ' +
    'Review it, then end with "Reviewed at aaaaaaa"'
  const reads = (requests, pattern = /\/commits|\/compare/) =>
    requests.filter((request) => pattern.test(request))

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
    assert.equal(statuses.at(-1), oldLine)
  })

  it('fails, and compares nothing, past 20 commits after the named one', async (context) => {
    const { statuses, requests } = await run({
      context,
      event: opened,
      pulls: { 3: earlier },
      routes: [commitsOf3(...merges(21))]
    })
    assert.equal(statuses.at(-1), oldLine)
    assert.deepEqual(reads(requests, /\/compare/), [])
  })

  it('fails, and compares nothing, when the listed commits do not reach the head', async (context) => {
    const { statuses, requests } = await run({
      context,
      event: opened,
      pulls: { 3: earlier },
      routes: [commitsOf3(...merges(1, NEXT))]
    })
    assert.equal(statuses.at(-1), oldLine)
    assert.deepEqual(reads(requests, /\/compare/), [])
  })

  it('reads no commit when the line names the head, or for a PR that needs no line', async (context) => {
    const dependabot = {
      ...pull({ number: 3, body: line }),
      user: { login: 'dependabot[bot]', type: 'Bot' }
    }
    for (const [pulls, routes] of [
      [{ 3: pull({ number: 3 }) }, []],
      [
        { 3: pull({ number: 3, fork: true, body: line }) },
        [reviewsOf3(approvalOf('bob'))]
      ],
      [
        { 3: dependabot },
        [{ match: '/pulls/3/files', value: [{ filename: 'package.json' }] }]
      ]
    ]) {
      const { statuses, requests } = await run({
        context,
        event: opened,
        pulls,
        routes
      })
      assert.match(statuses.at(-1), /success/)
      assert.deepEqual(reads(requests), [])
    }
  })

  it('reads no commit when the PR fails for another reason', async (context) => {
    const { statuses, requests } = await run({
      context,
      event: opened,
      pulls: { 3: earlier },
      routes: [reviewsOf3()]
    })
    assert.match(statuses.at(-1), /failure: No approver color/)
    assert.deepEqual(reads(requests), [])
  })
})
