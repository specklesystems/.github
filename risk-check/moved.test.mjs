import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OLD, approval, colorReview, files, pr, run } from './builders.mjs'
import { isGated, pickedFrom, sameChange } from './moved.mjs'

const SOURCE = '1111111111111111111111111111111111111111'
const patch = '@@ -10,3 +10,4 @@ function a() {\n context\n+added\n context'
const file = (overrides = {}) => ({
  path: 'src/a.ts',
  previousPath: undefined,
  status: 'modified',
  patch,
  ...overrides
})
const pick = (overrides = {}) => ({
  sourceGated: true,
  copy: [file()],
  source: [file()],
  ...overrides
})
const hotfix = pr({ baseRef: 'hotfix-2026.11', headRef: 'alice/pick' })

describe('a PR from a fork', () => {
  const fork = pr({ authorLogin: 'mallory', fromFork: true })

  it('fails with no color and no approval, and asks for the approval', () => {
    const result = run({ pr: fork })
    assert.equal(result.state, 'failure')
    assert.match(result.description, /needs an approval of a1b2c3d from an engineer/)
  })

  it('passes with no color once an engineer approves the head', () => {
    const result = run({ pr: fork, reviews: [approval('bob')] })
    assert.equal(result.state, 'success')
    assert.equal(result.color, null)
  })

  it('fails on a green color alone', () => {
    const result = run({ pr: fork, reviews: [colorReview('green', { login: 'bob' })] })
    assert.equal(result.state, 'failure')
  })

  it('takes the minimum color of a changed path with no approver color', () => {
    const result = run({
      pr: fork,
      files: files('packages/server/modules/core/migrations/001.ts'),
      reviews: [approval('bob')]
    })
    assert.equal(result.color, 'yellow')
    assert.equal(result.raisedBy.length, 1)
  })

  it('needs two approvals when red', () => {
    const result = run({
      pr: fork,
      files: files('.github/workflows/x.yml'),
      reviews: [approval('bob')]
    })
    assert.equal(result.state, 'failure')
  })

  it('ignores an approval that is stale, from the author or from a non-engineer', () => {
    const result = run({
      pr: fork,
      reviews: [
        approval('bob', { commitId: OLD }),
        approval('mallory'),
        approval('eve'),
        approval('SpeckleDevBot')
      ]
    })
    assert.equal(result.state, 'failure')
  })

  it('gets nothing from the emergency label, even with one approval when red', () => {
    const result = run({
      pr: pr({ authorLogin: 'mallory', fromFork: true, labels: ['emergency'] }),
      reviews: [colorReview('red', { login: 'bob' }), approval('bob')]
    })
    assert.equal(result.state, 'failure')
  })
})

describe('a PR that only moves merged changes', () => {
  it('is green from dev into main when dev requires the risk check', () => {
    const result = run({ pr: pr({ headRef: 'dev', headGated: true }) })
    assert.equal(result.color, 'green')
    assert.equal(result.state, 'success')
  })

  it('needs the approver from a dev branch that does not require the risk check', () => {
    const result = run({ pr: pr({ headRef: 'dev', headGated: false }) })
    assert.equal(result.color, null)
  })

  it('applies no minimum color', () => {
    const result = run({
      pr: pr({ headRef: 'dev', headGated: true }),
      files: files('.github/workflows/x.yml')
    })
    assert.equal(result.color, 'green')
  })

  it('is green into a hotfix branch when each commit copies a commit on trunk', () => {
    const result = run({ pr: hotfix, picks: [pick(), pick()] })
    assert.equal(result.color, 'green')
  })

  it('needs the approver when one commit has no source on a gated trunk', () => {
    const result = run({ pr: hotfix, picks: [pick(), pick({ sourceGated: false })] })
    assert.equal(result.color, null)
  })

  it('needs the approver when one commit changes more than its source', () => {
    const changed = [file({ patch: patch.replace('+added', '+added\n+extra') })]
    const result = run({ pr: hotfix, picks: [pick({ copy: changed })] })
    assert.equal(result.color, null)
  })

  it('needs the approver with no commits to compare', () => {
    const result = run({ pr: hotfix, picks: [] })
    assert.equal(result.color, null)
  })

  it('needs the approver from a fork', () => {
    const result = run({
      pr: pr({ baseRef: 'hotfix-2026.11', fromFork: true }),
      picks: [pick()],
      reviews: [approval('bob')]
    })
    assert.equal(result.color, null)
  })
})

describe('the comparison of a commit with its source', () => {
  it('ignores the line numbers of a hunk', () => {
    const moved = [file({ patch: patch.replace('-10,3 +10,4', '-42,3 +42,4') })]
    assert.equal(sameChange({ copy: moved, source: [file()] }), true)
  })

  it('rejects a file with no patch, such as a binary file', () => {
    const binary = [file({ patch: undefined })]
    assert.equal(sameChange({ copy: binary, source: binary }), false)
  })

  it('rejects an extra file', () => {
    const copy = [file(), file({ path: 'src/b.ts' })]
    assert.equal(sameChange({ copy, source: [file()] }), false)
  })

  it('rejects a commit that GitHub cannot list in full', () => {
    assert.equal(sameChange({ copy: null, source: [file()] }), false)
  })
})

describe('the cherry-pick line', () => {
  it('names the source commit', () => {
    const message = `fix: x\n\n(cherry picked from commit ${SOURCE})`
    assert.equal(pickedFrom(message), SOURCE)
  })

  it('is the last one when a commit was picked twice', () => {
    const first = '2222222222222222222222222222222222222222'
    const message = `fix: x\n\n(cherry picked from commit ${first})\n(cherry picked from commit ${SOURCE})`
    assert.equal(pickedFrom(message), SOURCE)
  })

  it('is missing from a plain commit', () => {
    assert.equal(pickedFrom('fix: x'), null)
  })
})

describe('the branches the check covers', () => {
  const cases = [
    ['main', true],
    ['trunk', true],
    ['dev', true],
    ['hotfix-2026.11', true],
    ['alice/stacked-base', false]
  ]
  for (const [baseRef, gated] of cases) {
    it(`${gated ? 'covers' : 'skips'} a PR into ${baseRef}`, () => {
      assert.equal(isGated({ baseRef, defaultBranch: 'trunk' }), gated)
    })
  }
})
