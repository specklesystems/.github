import { decide, parseConfig } from './decide.mjs'

export const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
export const OLD = 'ffffffffffffffffffffffffffffffffffffffff'

export const config = parseConfig(`
yellow:
  - "**/migrations/**"
bots:
  - SpeckleDevBot
`)

export const pr = (overrides = {}) => ({
  headSha: HEAD,
  url: 'https://github.com/o/r/pull/7',
  authorLogin: 'alice',
  authorIsBot: false,
  labels: [],
  baseRef: 'main',
  headRef: 'alice/change',
  headGated: false,
  fromFork: false,
  ...overrides
})

export const colorReview = (color, overrides = {}) => ({
  login: 'alice',
  state: 'COMMENTED',
  commitId: HEAD,
  body: `Approver result for commit ${HEAD.slice(0, 7)}: ${color}\n\n1 finding.`,
  ...overrides
})

export const approval = (login, overrides = {}) => ({
  login,
  state: 'APPROVED',
  commitId: HEAD,
  body: '',
  ...overrides
})

export const writers = new Set(['alice', 'bob', 'carol', 'SpeckleDevBot'])
export const files = (...paths) => paths.map((path) => ({ path }))

export const run = (input) =>
  decide({ pr: pr(), files: files('src/a.ts'), reviews: [], writers, config, ...input })
