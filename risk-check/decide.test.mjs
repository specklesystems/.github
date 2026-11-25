import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  HEAD,
  OLD,
  approval,
  colorReview,
  commit,
  files,
  merge,
  pr,
  run
} from './builders.mjs'
import { floorFor, globToRegExp, parseConfig, reviewLineToTrace } from './decide.mjs'

const repoConfig = parseConfig(
  readFileSync(new URL('./testdata/risk-floors.yml', import.meta.url), 'utf8')
)
const botPr = pr({ authorLogin: 'github-actions[bot]', authorIsBot: true })

describe('the approver color', () => {
  it('is required: without one for the head the check fails and names the command', () => {
    const result = run({ reviews: [colorReview('green', { commitId: OLD })] })
    assert.equal(result.state, 'failure')
    assert.equal(result.color, null)
    assert.match(
      result.description,
      /Run \/approver https:\/\/github.com\/o\/r\/pull\/7/
    )
  })

  it('counts only from an account with write access', () => {
    const result = run({ reviews: [colorReview('green', { login: 'mallory' })] })
    assert.equal(result.state, 'failure')
  })

  it('ignores a result whose header names another commit', () => {
    const body = `Approver result for commit ${OLD.slice(0, 7)}: green`
    const result = run({ reviews: [colorReview('green', { body })] })
    assert.equal(result.color, null)
  })

  it('comes from the latest color review of the head', () => {
    const result = run({ reviews: [colorReview('red'), colorReview('green')] })
    assert.equal(result.color, 'green')
    assert.equal(result.state, 'success')
  })
})

describe('minimum colors', () => {
  it('raise the color to the floor of a changed path and mark that file', () => {
    const result = run({
      files: files('packages/server/modules/core/migrations/001.ts', 'src/a.ts'),
      reviews: [colorReview('green')]
    })
    assert.equal(result.color, 'yellow')
    assert.equal(result.state, 'success')
    assert.deepEqual(result.raisedBy, [
      { path: 'packages/server/modules/core/migrations/001.ts', color: 'yellow' }
    ])
  })

  it('mark no file when the approver color already meets its floor', () => {
    const result = run({
      files: files('packages/server/modules/core/migrations/001.ts'),
      reviews: [colorReview('yellow')]
    })
    assert.equal(result.color, 'yellow')
    assert.deepEqual(result.raisedBy, [])
  })

  it('keep .github/ red with no floors file entry', () => {
    const result = run({
      files: files('.github/workflows/x.yml'),
      reviews: [colorReview('green')],
      config: parseConfig('')
    })
    assert.equal(result.color, 'red')
    assert.equal(result.state, 'failure')
  })

  it('apply to the old path of a renamed file', () => {
    const result = run({
      files: [{ path: 'docs/x.yml', previousPath: '.github/x.yml' }],
      reviews: [colorReview('green')]
    })
    assert.equal(result.color, 'red')
  })
})

describe('a red PR', () => {
  it('fails on the approval of its own author', () => {
    const result = run({ reviews: [colorReview('red'), approval('alice')] })
    assert.equal(result.state, 'failure')
  })

  it('fails on an approval of an earlier commit', () => {
    const result = run({
      reviews: [colorReview('red'), approval('bob', { commitId: OLD })]
    })
    assert.equal(result.state, 'failure')
  })

  it('passes on an approval of the head from another engineer', () => {
    const result = run({ reviews: [colorReview('red'), approval('bob')] })
    assert.equal(result.state, 'success')
  })

  it('fails again once that approval is dismissed', () => {
    const result = run({
      reviews: [
        colorReview('red'),
        approval('bob'),
        approval('bob', { state: 'DISMISSED' })
      ]
    })
    assert.equal(result.state, 'failure')
  })

  it('fails when the approving engineer later requests changes', () => {
    const result = run({
      reviews: [
        colorReview('red'),
        approval('bob'),
        approval('bob', { state: 'CHANGES_REQUESTED' })
      ]
    })
    assert.equal(result.state, 'failure')
  })

  it('does not count a machine account listed in a repo floors file', () => {
    const result = run({
      reviews: [colorReview('red'), approval('SpeckleDevBot')],
      config: repoConfig
    })
    assert.equal(result.state, 'failure')
  })

  it('from a bot fails on one approval', () => {
    const result = run({
      pr: botPr,
      reviews: [colorReview('red', { login: 'bob' }), approval('bob')]
    })
    assert.equal(result.state, 'failure')
  })

  it('from a bot passes on two approvals', () => {
    const result = run({
      pr: botPr,
      reviews: [
        colorReview('red', { login: 'bob' }),
        approval('bob'),
        approval('carol')
      ]
    })
    assert.equal(result.state, 'success')
  })

  it('from an outside contributor fails on one approval', () => {
    const result = run({
      pr: pr({ authorLogin: 'mallory' }),
      reviews: [colorReview('red', { login: 'bob' }), approval('bob')]
    })
    assert.equal(result.state, 'failure')
  })

  it('passes with the emergency label', () => {
    const result = run({
      pr: pr({ labels: ['emergency'] }),
      reviews: [colorReview('red')]
    })
    assert.equal(result.state, 'success')
    assert.equal(result.emergency, true)
  })
})

describe('a Dependabot PR', () => {
  const dependabot = pr({ authorLogin: 'dependabot[bot]', authorIsBot: true })

  it('is green with no approver run when it changes only dependency files', () => {
    const result = run({
      pr: dependabot,
      files: files('package.json', 'packages/server/package.json', 'pnpm-lock.yaml')
    })
    assert.equal(result.color, 'green')
    assert.equal(result.state, 'success')
  })

  it('needs the approver when it changes a file under .github/', () => {
    const result = run({
      pr: dependabot,
      files: files('.github/workflows/package.json')
    })
    assert.equal(result.state, 'failure')
    assert.equal(result.color, null)
  })

  it('needs the approver when it changes source code', () => {
    const result = run({
      pr: dependabot,
      files: files('pnpm-lock.yaml', 'packages/server/app.ts')
    })
    assert.equal(result.color, null)
  })
})

describe('a repo floors file', () => {
  const cases = [
    ['packages/server/modules/core/migrations/2026-x.ts', 'yellow'],
    ['packages/server/modules/workspaces/authz/x.ts', 'yellow'],
    ['packages/shared/src/authz/policies/x.ts', 'yellow'],
    ['AGENTS.md', 'yellow'],
    ['agents/skills/approver/SKILL.md', 'yellow'],
    ['.claude/settings.json', 'yellow'],
    ['.betterleaks.toml', 'yellow'],
    ['packages/frontend-3/components/agents/AgentCard.vue', null],
    ['packages/frontend-3/pages/index.vue', null]
  ]
  for (const [path, color] of cases) {
    it(`gives ${path} the minimum color ${color}`, () => {
      assert.equal(floorFor({ path, config: repoConfig }), color)
    })
  }
})

describe('a PR that changes the floors file', () => {
  const unreadable = { text: 'yellow:\n  src/**\n' }
  const approved = {
    files: files('.github/risk-floors.yml'),
    reviews: [colorReview('red'), approval('bob')]
  }

  it('fails while the file at its head has a line the check cannot read', () => {
    const result = run({ ...approved, headFloors: unreadable })
    assert.equal(result.state, 'failure')
    assert.equal(
      result.description,
      'This PR breaks the floors file: .github/risk-floors.yml line 2: ' +
        'expected one of "yellow:", "red:", "bots:" or "  - <value>"'
    )
    assert.equal(result.color, 'red')
  })

  it('fails while the file at its head has a path the check cannot match', () => {
    const result = run({
      ...approved,
      headFloors: { text: 'red:\n  - src/a**b\n' }
    })
    assert.equal(result.state, 'failure')
    assert.match(result.description, /whole path segment: src\/a\*\*b/)
  })

  it('does not pass on the emergency label', () => {
    const result = run({
      pr: pr({ labels: ['emergency'] }),
      files: files('.github/risk-floors.yml'),
      reviews: [colorReview('red')],
      headFloors: unreadable
    })
    assert.equal(result.state, 'failure')
    assert.equal(result.emergency, false)
  })

  it('passes on its approval when the file at its head reads', () => {
    const result = run({ ...approved, headFloors: { text: 'red:\n  - src/**\n' } })
    assert.equal(result.state, 'success')
  })

  it('fails when the check got no file at its head, also with the emergency label', () => {
    const result = run({
      pr: pr({ labels: ['emergency'] }),
      files: files('.github/risk-floors.yml'),
      reviews: [colorReview('red')],
      headFloors: { unread: 'HTTP 502' }
    })
    assert.equal(result.state, 'failure')
    assert.equal(result.emergency, false)
    assert.equal(
      result.description,
      'The check could not read the floors file of this PR (HTTP 502); run it again'
    )
  })
})

describe('the floors file format', () => {
  it('rejects a list item without a dash', () => {
    assert.throws(() => parseConfig('yellow:\n  migrations/**\n'), /line 2/)
  })

  it('rejects an unknown section', () => {
    assert.throws(() => parseConfig('green:\n  - a\n'), /line 1/)
  })

  it('rejects a "**" inside a path segment', () => {
    assert.throws(() => parseConfig('red:\n  - src/a**b\n'), /whole path segment/)
  })

  const globCases = [
    ['**/migrations/**', 'migrations/1.ts', true],
    ['**/migrations/**', 'a/b/migrations/c/1.ts', true],
    ['packages/*/auth/**', 'packages/server/auth/x.ts', true],
    ['packages/*/auth/**', 'packages/a/b/auth/x.ts', false],
    ['.betterleaks.toml', 'x.betterleaks.toml', false]
  ]
  for (const [glob, path, expected] of globCases) {
    it(`${expected ? 'matches' : 'does not match'} ${path} with ${glob}`, () => {
      assert.equal(globToRegExp(glob).test(path), expected)
    })
  }
})

describe('the code review line', () => {
  const head7 = HEAD.slice(0, 7)
  const EARLIER = '1234567890abcdef1234567890abcdef12345678'
  const BASE_TIP = '9999999999999999999999999999999999999999'
  const FEATURE = '8888888888888888888888888888888888888888'
  const described = (description, overrides = {}) => pr({ description, ...overrides })
  const green = [colorReview('green')]
  const missing = `The description must end with "Reviewed at ${head7}" (the pr skill writes it)`
  const old = (named) =>
    `The description ends with "Reviewed at ${named}"; the newest commit is ${head7}. ` +
    `Review it, then end with "Reviewed at ${head7}"`

  it('fails a PR that would pass when the description has none', () => {
    const result = run({ pr: described('Summary.'), reviews: green })
    assert.equal(result.state, 'failure')
    assert.equal(result.color, 'green')
    assert.equal(result.description, missing)
  })

  it('fails when the line is not the last line', () => {
    const result = run({
      pr: described(`Reviewed at ${head7}\n\nOne more thing.`),
      reviews: green
    })
    assert.equal(result.description, missing)
  })

  it('fails when the line names a commit that is not one of the PR', () => {
    const result = run({
      pr: described(`Reviewed at ${OLD}`),
      reviews: green,
      commits: [commit(HEAD, [EARLIER, false])]
    })
    assert.equal(result.state, 'failure')
    assert.equal(result.description, old('fffffff'))
  })

  it('passes on the newest commit, with backticks, a full sha and blank lines around it', () => {
    for (const line of [`Reviewed at \`${head7}\``, `  Reviewed at ${HEAD}  `]) {
      const result = run({
        pr: described(`Summary.\r\n\r\n${line}\r\n\n`),
        reviews: green
      })
      assert.equal(result.state, 'success', line)
    }
  })

  it('passes on an earlier commit when only merges from the base branch follow it', () => {
    const result = run({
      pr: described(`Reviewed at ${EARLIER.slice(0, 7)}`),
      reviews: green,
      commits: [
        commit(EARLIER, [OLD, true]),
        commit(FEATURE, [EARLIER, false], [BASE_TIP, true]),
        commit(HEAD, [FEATURE, false], [BASE_TIP, true])
      ]
    })
    assert.equal(result.state, 'success')
  })

  it('fails on an earlier commit when a merge of another branch follows it', () => {
    const result = run({
      pr: described(`Reviewed at ${EARLIER.slice(0, 7)}`),
      reviews: green,
      commits: [
        commit(EARLIER, [OLD, true]),
        commit(HEAD, [EARLIER, false], [FEATURE, false])
      ]
    })
    assert.equal(result.description, old('1234567'))
  })

  it('fails on an earlier commit when an ordinary commit follows it', () => {
    const result = run({
      pr: described(`Reviewed at ${EARLIER.slice(0, 7)}`),
      reviews: green,
      commits: [commit(EARLIER, [OLD, true]), commit(HEAD, [EARLIER, false])]
    })
    assert.equal(result.state, 'failure')
  })

  it('fails on an earlier commit when the check got no list of commits', () => {
    const result = run({
      pr: described(`Reviewed at ${EARLIER.slice(0, 7)}`),
      reviews: green
    })
    assert.equal(result.description, old('1234567'))
  })

  it('is not waived by the emergency label', () => {
    const result = run({
      pr: described('Summary.', { labels: ['emergency'] }),
      reviews: [colorReview('red')]
    })
    assert.equal(result.state, 'failure')
    assert.equal(result.emergency, false)
    assert.equal(result.description, missing)
  })

  it('comes after the other failures', () => {
    const noColor = run({ pr: described('Summary.') })
    assert.match(noColor.description, /^No approver color/)
    const brokenFloors = run({
      pr: described('Summary.'),
      files: files('.github/risk-floors.yml'),
      reviews: [colorReview('red'), approval('bob')],
      headFloors: { text: 'nope\n' }
    })
    assert.match(brokenFloors.description, /^This PR breaks the floors file/)
  })

  it('is not needed on a PR from a fork', () => {
    const result = run({
      pr: described('Summary.', { authorLogin: 'mallory', fromFork: true }),
      reviews: [approval('bob')]
    })
    assert.equal(result.state, 'success')
  })

  it('is not needed on a Dependabot dependency update', () => {
    const result = run({
      pr: described('Bumps x.', { authorLogin: 'dependabot[bot]', authorIsBot: true }),
      files: files('package.json')
    })
    assert.equal(result.state, 'success')
  })

  it('is not needed on a hotfix PR of exact copies', () => {
    const file = { path: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }
    const result = run({
      pr: described('Hotfix.', { baseRef: 'hotfix-1', headRef: 'alice/pick' }),
      picks: [{ sourceGated: true, copy: [file], source: [file] }]
    })
    assert.equal(result.state, 'success')
  })
})

describe('reviewLineToTrace', () => {
  const EARLIER = '1234567890abcdef1234567890abcdef12345678'
  const input = (overrides) => ({ files: files('src/a.ts'), picks: [], ...overrides })

  it('names the commit to look up only when the line names an earlier one', () => {
    assert.equal(
      reviewLineToTrace(
        input({ pr: pr({ description: `Reviewed at ${EARLIER.slice(0, 9)}` }) })
      ),
      EARLIER.slice(0, 9)
    )
    assert.equal(reviewLineToTrace(input({ pr: pr() })), null)
    assert.equal(reviewLineToTrace(input({ pr: pr({ description: '' }) })), null)
  })

  it('names none for a PR that needs no line', () => {
    const description = `Reviewed at ${EARLIER.slice(0, 7)}`
    assert.equal(
      reviewLineToTrace(input({ pr: pr({ description, fromFork: true }) })),
      null
    )
    assert.equal(
      reviewLineToTrace(
        input({
          pr: pr({ description, authorLogin: 'dependabot[bot]', authorIsBot: true }),
          files: files('pnpm-lock.yaml')
        })
      ),
      null
    )
  })
})

describe('after the merge', () => {
  const green = colorReview('green')
  const merged = (input) =>
    run({ reviews: [green], merge: merge(), ...input }).afterMerge

  it('owes a review when the branch requires an approval and the PR has none', () => {
    const result = merged({})
    assert.equal(result.owes, true)
    assert.equal(result.reviewed, false)
    assert.match(result.reasons.join(), /needs 1 approval/)
  })

  it('owes none with an approval of the head from another engineer', () => {
    const result = merged({ reviews: [green, approval('bob')] })
    assert.deepEqual(result, { owes: false, reviewed: true, reasons: [] })
  })

  const notCounted = [
    ['the author', [approval('alice')], {}],
    ['the person who pushed last', [approval('bob')], { pushedBy: ['bob'] }],
    ['an account GitHub calls a bot', [approval('bob', { isBot: true })], {}],
    ['a machine account in the floors file', [approval('SpeckleDevBot')], {}],
    ['an account without write access', [approval('mallory')], {}],
    ['an earlier commit', [approval('bob', { commitId: OLD })], {}],
    [
      'a reviewer who later requested changes',
      [approval('bob'), approval('bob', { state: 'CHANGES_REQUESTED' })],
      {}
    ],
    [
      'a dismissed approval',
      [approval('bob'), approval('bob', { state: 'DISMISSED' })],
      {}
    ]
  ]
  for (const [who, reviews, mergeOverrides] of notCounted) {
    it(`does not count an approval from ${who}`, () => {
      const result = merged({
        reviews: [green, ...reviews],
        merge: merge(mergeOverrides)
      })
      assert.equal(result.owes, true)
      assert.equal(result.reviewed, false)
    })
  }

  it('owes a review when the branch requires two approvals and the PR has one', () => {
    const result = merged({
      reviews: [green, approval('bob')],
      merge: merge({ requiredApprovals: 2 })
    })
    assert.equal(result.owes, true)
  })

  it('owes none on a branch that requires no approval', () => {
    const result = merged({ merge: merge({ requiredApprovals: 0 }) })
    assert.deepEqual(result, { owes: false, reviewed: false, reasons: [] })
  })

  it('owes a review for every merge with the emergency label and no approval, whatever the evaluation', () => {
    const result = merged({
      pr: pr({ labels: ['emergency'] }),
      merge: merge({ requiredApprovals: 0 })
    })
    assert.equal(result.owes, true)
    assert.match(result.reasons.join(), /emergency/)
  })

  it('owes none for an emergency merge with one approval on a branch that requires none', () => {
    const result = merged({
      pr: pr({ labels: ['emergency'] }),
      reviews: [green, approval('bob')],
      merge: merge({ requiredApprovals: 0 })
    })
    assert.equal(result.owes, false)
  })

  it('owes a review when the evaluation fails or passes on the emergency label', () => {
    assert.equal(
      merged({ reviews: [], merge: merge({ requiredApprovals: 0 }) }).owes,
      true
    )
    const emergency = merged({
      pr: pr({ labels: ['emergency'] }),
      reviews: [colorReview('red')],
      merge: merge({ requiredApprovals: 0 })
    })
    assert.equal(emergency.owes, true)
  })

  it('owes a review, and settles none, when the check could not read the rules of the branch', () => {
    const result = merged({
      reviews: [green, approval('bob')],
      merge: { unread: 'the rules of main (HTTP 502)', pushedBy: [] }
    })
    assert.equal(result.owes, true)
    assert.equal(result.reviewed, false)
    assert.match(result.reasons.join(), /HTTP 502/)
  })

  it('takes no later color review from the author as the review after an emergency', () => {
    const result = merged({
      pr: pr({ labels: ['emergency'] }),
      reviews: [colorReview('red'), colorReview('green')],
      merge: merge({ requiredApprovals: 0 })
    })
    assert.equal(result.reviewed, false)
  })

  it('needs two such approvals for a PR from a bot', () => {
    const botMerge = (reviews) =>
      merged({
        pr: pr({ authorLogin: 'github-actions[bot]', authorIsBot: true }),
        reviews: [colorReview('green', { login: 'bob' }), ...reviews],
        merge: merge({ pushedBy: ['github-actions[bot]'] })
      })
    assert.equal(botMerge([approval('bob')]).reviewed, false)
    assert.equal(botMerge([approval('bob'), approval('carol')]).reviewed, true)
  })

  it('is only worked out for a merged PR', () => {
    assert.equal(run({ reviews: [green] }).afterMerge, undefined)
  })
})
