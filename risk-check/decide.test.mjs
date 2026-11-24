import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { HEAD, OLD, approval, colorReview, files, pr, run } from './builders.mjs'
import { floorFor, globToRegExp, parseConfig } from './decide.mjs'

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
    assert.equal(result.approved, true)
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

  it('passes with the emergency label and stays unapproved', () => {
    const result = run({
      pr: pr({ labels: ['emergency'] }),
      reviews: [colorReview('red')]
    })
    assert.equal(result.state, 'success')
    assert.equal(result.emergency, true)
    assert.equal(result.approved, false)
  })

  it('stays unapproved when its author later posts a lower color', () => {
    const result = run({
      pr: pr({ labels: ['emergency'] }),
      reviews: [colorReview('red'), colorReview('green')]
    })
    assert.equal(result.approved, false)
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
