import { movesMergedChanges } from './moved.mjs'
import { reviewLineProblem, reviewedCommit } from './review-line.mjs'

export const COLORS = ['green', 'yellow', 'red']

const rank = (color) => COLORS.indexOf(color)

const APPROVER_RESULT =
  /^Approver result for commit ([0-9a-f]{7,40}): (green|yellow|red)\b/

const DEPENDENCY_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'yarn.lock',
  'requirements.txt',
  'poetry.lock',
  'pyproject.toml',
  'uv.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock'
])

const CONFIG_SECTIONS = ['yellow', 'red', 'bots']

export const parseConfig = (text) => {
  const config = Object.fromEntries(CONFIG_SECTIONS.map((key) => [key, []]))
  let section = null
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.replace(/(^|\s)#.*$/, '').trimEnd()
    if (!line.trim()) continue
    const header = /^([a-z]+):$/.exec(line)
    if (header && CONFIG_SECTIONS.includes(header[1])) {
      section = header[1]
      continue
    }
    const item = /^\s+-\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/.exec(line)
    if (item && section) {
      config[section].push(item[1] ?? item[2] ?? item[3])
      continue
    }
    throw new Error(
      `.github/risk-floors.yml line ${index + 1}: expected one of ` +
        `${CONFIG_SECTIONS.map((key) => `"${key}:"`).join(', ')} or "  - <value>"`
    )
  }
  for (const glob of [...config.yellow, ...config.red]) globToRegExp(glob)
  return config
}

export const globToRegExp = (glob) => {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*' && glob[i + 1] === '*') {
      const wholeSegment =
        (i === 0 || glob[i - 1] === '/') && [undefined, '/'].includes(glob[i + 2])
      if (!wholeSegment) throw new Error(`"**" must be a whole path segment: ${glob}`)
      source += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += 2
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

const matchesAny = ({ path, globs }) =>
  globs.some((glob) => globToRegExp(glob).test(path))

// Every change under .github/ is red, whatever the floors file says: these files
// define the checks themselves, the floors file included.
export const floorFor = ({ path, config }) => {
  if (path.startsWith('.github/') || matchesAny({ path, globs: config.red }))
    return 'red'
  if (matchesAny({ path, globs: config.yellow })) return 'yellow'
  return null
}

const pathsOf = (files) =>
  files.flatMap(({ path, previousPath }) => [
    ...new Set([path, previousPath].filter(Boolean))
  ])

const isDependencyUpdate = ({ pr, files }) =>
  pr.authorLogin === 'dependabot[bot]' &&
  pathsOf(files).every(
    (path) =>
      !path.startsWith('.github/') && DEPENDENCY_FILES.has(path.split('/').at(-1))
  )

const latestApproverColor = ({ pr, reviews, isEngineer }) => {
  const colors = reviews
    .filter((review) => review.commitId === pr.headSha && isEngineer(review.login))
    .map((review) => APPROVER_RESULT.exec(review.body ?? ''))
    .filter((match) => match && pr.headSha.startsWith(match[1]))
    .map((match) => match[2])
  return colors.at(-1) ?? null
}

const engineerIn =
  ({ writers, config }) =>
  (login) =>
    writers.has(login) && !login.endsWith('[bot]') && !config.bots.includes(login)

const neededApprovals = ({ pr, isEngineer }) =>
  pr.authorIsBot || !isEngineer(pr.authorLogin) ? 2 : 1

const approvalsOfHead = ({ pr, reviews, isEngineer }) => {
  const latestByReviewer = new Map()
  for (const review of reviews) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
      latestByReviewer.set(review.login, review)
    }
  }
  return [...latestByReviewer.values()].filter(
    (review) =>
      review.state === 'APPROVED' &&
      review.commitId === pr.headSha &&
      review.login !== pr.authorLogin &&
      isEngineer(review.login)
  )
}

// The emergency label does nothing on a PR from a fork: an engineer who needs the
// change at once pushes it to a branch of this repo (speckle-next#3 review thread).
const redStatus = ({ pr, approvers, needed }) => {
  if (approvers.length >= needed) {
    return { state: 'success', description: `red, approved by ${approvers.join(', ')}` }
  }
  if (pr.labels.includes('emergency') && !pr.fromFork) {
    return {
      state: 'success',
      emergency: true,
      description:
        'red, emergency label: another engineer approves within 3 working days of the merge'
    }
  }
  const sha = pr.headSha.slice(0, 7)
  return {
    state: 'failure',
    description:
      needed === 2
        ? `red: needs approvals of ${sha} from two engineers (PR from a bot or outside contributor)`
        : `red: needs an approval of ${sha} from an engineer other than the author`
  }
}

// The check colors these PRs itself, so they need no approver color and no code
// review line.
const ownColor = ({ pr, files, picks = [] }) => {
  if (movesMergedChanges({ pr, picks }))
    return 'green: moves changes that already merged'
  if (isDependencyUpdate({ pr, files })) return 'green: Dependabot dependency update'
  return null
}

const decideFromReviews = ({ pr, files, reviews, writers, config, picks }) => {
  const isEngineer = engineerIn({ writers, config })
  const needed = neededApprovals({ pr, isEngineer })
  const approvers = approvalsOfHead({ pr, reviews, isEngineer }).map(
    ({ login }) => login
  )
  const result = ({ color, raisedBy = [], ...status }) => ({
    color,
    emergency: false,
    raisedBy,
    ...status
  })

  const own = ownColor({ pr, files, picks })
  if (own) return result({ color: 'green', state: 'success', description: own })

  const sha = pr.headSha.slice(0, 7)
  const approverColor = latestApproverColor({ pr, reviews, isEngineer })
  if (!approverColor && !pr.fromFork) {
    return result({
      color: null,
      state: 'failure',
      description: `No approver color for ${sha}. Run /approver ${pr.url}`
    })
  }

  // A floor comment marks a file the approver colored too low. Where the approver's
  // color already meets the floor, its own findings carry the review, so the floor
  // adds no second thread.
  const raisedBy = pathsOf(files)
    .map((path) => ({ path, color: floorFor({ path, config }) }))
    .filter(({ color }) => color && rank(color) > rank(approverColor))
  const color = raisedBy.reduce(
    (current, floor) => (rank(floor.color) > rank(current) ? floor.color : current),
    approverColor
  )
  const source = approverColor ? `approver ${approverColor}, raised by` : 'minimum from'
  const raised = raisedBy.length ? ` (${source} .github/risk-floors.yml)` : ''

  if (color === 'red') {
    const status = redStatus({ pr, approvers, needed })
    return result({
      color,
      raisedBy,
      ...status,
      description: status.description + raised
    })
  }
  if (pr.fromFork && !approvers.length) {
    return result({
      color,
      raisedBy,
      state: 'failure',
      description: `${color ?? 'no color'}${raised}: a PR from a fork needs an approval of ${sha} from an engineer`
    })
  }
  const next = color === 'yellow' ? ': resolve each finding before the merge' : ''
  return result({
    color,
    raisedBy,
    state: 'success',
    description: color
      ? `${color}${raised}${next}`
      : `no color: PR from a fork, approved by ${approvers.join(', ')}`
  })
}

const floorsProblem = ({ text, unread }) => {
  if (unread)
    return `The check could not read the floors file of this PR (${unread}); run it again`
  try {
    parseConfig(text)
    return null
  } catch (error) {
    return `This PR breaks the floors file: ${error.message}`
  }
}

const needsReviewLine = (input) => !input.pr.fromFork && !ownColor(input)

// The check reads the floors file from the default branch. A file it cannot read
// there fails every later PR, so the PR that would merge one fails instead, and the
// emergency label does not pass it. `headFloors` is set when the PR changes the
// file: its `text` at the PR's head, or why the check got none (`unread`).
const gateBeforeLine = ({ headFloors = null, ...input }) => {
  const result = decideFromReviews(input)
  const problem = headFloors && floorsProblem(headFloors)
  return problem
    ? { ...result, state: 'failure', emergency: false, description: problem }
    : result
}

// Tracing an earlier commit costs API calls, so `run.mjs` reads the commits only
// when the line is all that is left to decide.
export const reviewLineToTrace = (input) => {
  if (!needsReviewLine(input) || gateBeforeLine(input).state !== 'success') return null
  const named = reviewedCommit(input.pr.description)
  return named && !input.pr.headSha.startsWith(named) ? named : null
}

// The code review line comes last, and the emergency label does not waive it.
const gate = ({ commits = null, ...input }) => {
  const result = gateBeforeLine(input)
  const problem =
    result.state === 'success' &&
    needsReviewLine(input) &&
    reviewLineProblem({ pr: input.pr, commits })
  return problem
    ? { ...result, state: 'failure', emergency: false, description: problem }
    : result
}

// GitHub counts an approval from any account with write access, so a merge it let
// through can still owe the review. `merge.requiredApprovals` is the count the
// rules of the base branch ask for, or null when the check could not read them.
const afterMerge = ({ pr, reviews, writers, config, merge, result }) => {
  const isEngineer = engineerIn({ writers, config })
  const count = approvalsOfHead({ pr, reviews, isEngineer }).filter(
    (review) => !review.isBot
  ).length
  const required = merge.requiredApprovals
  const forColor = result.color === 'red' ? neededApprovals({ pr, isEngineer }) : 1
  return {
    owes:
      result.state !== 'success' ||
      result.emergency ||
      required === null ||
      count < required,
    reviewed: required !== null && count >= Math.max(required, forColor)
  }
}

// `merge` is set for a merged PR only: `afterMerge.owes` asks for the label
// review-after-merge at the merge, and `afterMerge.reviewed` removes it later.
export const decide = ({ merge, ...input }) => {
  const result = gate(input)
  return merge
    ? { ...result, afterMerge: afterMerge({ ...input, merge, result }) }
    : result
}
