import { readFile } from 'node:fs/promises'
import { COLORS, decide, parseConfig, reviewLineToTrace } from './decide.mjs'
import {
  addLabel,
  api,
  paginate,
  removeLabel,
  setStatus,
  unless404,
  unlessMissing
} from './github.mjs'
import { LABEL, loadMerge, settleMerged } from './merged.mjs'
import { isGated, pickedFrom } from './moved.mjs'
import { loadCommits } from './review-commits.mjs'

const FLOORS_FILE = '.github/risk-floors.yml'
const WRITE_PERMISSIONS = new Set(['admin', 'write'])
const COMMIT_FILES_PAGE = 300
const MAX_PICKS = 20
const MAX_LIST_PAGES = 10

const loadConfig = async ({ defaultBranch }) =>
  parseConfig(
    await api({
      path: `/contents/${FLOORS_FILE}?ref=${defaultBranch}`,
      raw: true
    }).catch(unless404(''))
  )

const loadWriters = async ({ logins }) => {
  const permissions = await Promise.all(
    [...new Set(logins)].map(async (login) => {
      const { permission } = await api({
        path: `/collaborators/${encodeURIComponent(login)}/permission`
      }).catch(unless404({ permission: 'none' }))
      return [login, permission]
    })
  )
  return new Set(
    permissions
      .filter(([, permission]) => WRITE_PERMISSIONS.has(permission))
      .map(([login]) => login)
  )
}

// A branch name alone proves nothing: anyone can create a branch named dev. Only a
// branch whose live rules require risk-check holds changes that passed this gate.
const requiresRiskCheck = async ({ branch }) =>
  (
    await api({ path: `/rules/branches/${encodeURIComponent(branch)}` }).catch(
      unless404([])
    )
  ).some(
    (rule) =>
      rule.type === 'required_status_checks' &&
      rule.parameters.required_status_checks.some(
        ({ context }) => context === 'risk-check'
      )
  )

const contains = async ({ branch, sha }) => {
  const comparison = await api({
    path: `/compare/${sha}...${encodeURIComponent(branch)}`
  }).catch(unlessMissing(null))
  return ['ahead', 'identical'].includes(comparison?.status)
}

// One response lists at most 300 files of a commit. A longer list, or a merge
// commit, cannot be compared in full, so it counts as not comparable.
const commitFiles = async ({ sha }) => {
  const commit = await api({ path: `/commits/${sha}` }).catch(unlessMissing(null))
  if (!commit || commit.parents.length !== 1) return null
  if (commit.files.length >= COMMIT_FILES_PAGE) return null
  return commit.files.map((file) => ({
    path: file.filename,
    previousPath: file.previous_filename,
    status: file.status,
    patch: file.patch
  }))
}

const loadPicks = async ({ pull }) => {
  // A longer hotfix PR follows the normal rules, so one run stays far below the 1,000
  // API requests an hour that this repo's workflows share (speckle-next#3 thread).
  if (pull.commits > MAX_PICKS) return []
  const commits = await paginate({ path: `/pulls/${pull.number}/commits` })
  if (commits.length !== pull.commits) return []
  const candidates = [...new Set([pull.base.repo.default_branch, 'main', 'dev'])]
  const gated = await Promise.all(
    candidates.map((branch) => requiresRiskCheck({ branch }))
  )
  const trunks = candidates.filter((_, index) => gated[index])
  // One commit at a time, to stay below GitHub's limit of 100 requests in parallel.
  const picks = []
  for (const { sha, commit } of commits) {
    const sourceSha = pickedFrom(commit.message)
    if (!sourceSha || !trunks.length) return []
    const [onTrunk, copy, source] = await Promise.all([
      Promise.all(trunks.map((branch) => contains({ branch, sha: sourceSha }))),
      commitFiles({ sha }),
      commitFiles({ sha: sourceSha })
    ])
    picks.push({ sourceGated: onTrunk.some(Boolean), copy, source })
  }
  return picks
}

const floorMarker = (path) => `<!-- risk-floor:${path} -->`

const floorBody = ({ path, name, color, rule }) => {
  const match = name === path ? `\`${path}\`` : `\`${path}\` was \`${name}\`, which`
  return (
    `${floorMarker(path)}\n**Minimum color ${color}:** ${match} matches \`${rule}\`` +
    `${color === 'red' ? ', so another engineer approves the latest commit' : ''}. ` +
    'Answer this like an approver finding: reply with why the change is safe, then resolve.'
  )
}

const postFloorComments = async ({ number, headSha, floors }) => {
  if (!floors.length) return
  const existing = (await paginate({ path: `/pulls/${number}/comments` }))
    .filter(({ user }) => user?.login === 'github-actions[bot]')
    .map(({ body }) => body)
  for (const floor of floors) {
    if (existing.some((body) => body.startsWith(floorMarker(floor.path)))) continue
    const comment = {
      body: floorBody(floor),
      commit_id: headSha,
      path: floor.path,
      subject_type: 'file'
    }
    const path = `/pulls/${number}/comments`
    await api({ method: 'POST', path, body: comment }).catch(async (error) => {
      if (error.status !== 422) throw error
      await api({ method: 'POST', path, body: { ...comment, side: 'LEFT' } })
    })
  }
}

// A commit status belongs to a commit, not to a PR, so a second open PR with the
// same head would share one result: the check refuses to color either. GitHub's
// list of the PRs for a commit can miss a PR from a fork, so this reads the open PRs.
const otherPullsWithHead = async ({ pull }) =>
  (await paginate({ path: '/pulls' }))
    .filter(
      (other) =>
        other.head.sha === pull.head.sha &&
        other.number !== pull.number &&
        isGated({
          baseRef: other.base.ref,
          defaultBranch: other.base.repo.default_branch
        })
    )
    .map(({ number }) => number)

// A failed read must not fail the run: the workflow passes a failed run on the
// emergency label, and that would merge a file the check never read (.github#7).
const loadHeadFloors = async ({ files, headSha }) => {
  const changed = files.some(
    ({ filename, status }) => filename === FLOORS_FILE && status !== 'removed'
  )
  if (!changed) return null
  return api({ path: `/contents/${FLOORS_FILE}?ref=${headSha}`, raw: true }).then(
    (text) => ({ text }),
    (error) => ({ unread: error.status ? `HTTP ${error.status}` : 'no response' })
  )
}

const evaluate = async ({ action, pull }) => {
  const number = pull.number
  const baseRef = pull.base.ref
  const fromFork = pull.head.repo?.full_name !== pull.base.repo.full_name
  const [config, files, reviews, picks, headGated] = await Promise.all([
    loadConfig({ defaultBranch: pull.base.repo.default_branch }),
    paginate({ path: `/pulls/${number}/files` }),
    paginate({ path: `/pulls/${number}/reviews` }),
    baseRef.startsWith('hotfix-') && !fromFork ? loadPicks({ pull }) : [],
    pull.head.ref === 'dev' ? requiresRiskCheck({ branch: 'dev' }) : false
  ])
  if (files.length < pull.changed_files) {
    const description = `GitHub lists only ${files.length} of the ${pull.changed_files} changed files; split the PR`
    return { state: 'failure', description }
  }
  const reviewList = reviews
    .filter((review) => review.user)
    .map((review) => ({
      login: review.user.login,
      isBot: review.user.type === 'Bot',
      state: review.state,
      commitId: review.commit_id,
      body: review.body
    }))
  const pr = {
    headSha: pull.head.sha,
    url: pull.html_url,
    authorLogin: pull.user.login,
    authorIsBot: pull.user.type === 'Bot',
    labels: pull.labels.map(({ name }) => name),
    baseRef,
    headRef: pull.head.ref,
    headGated,
    fromFork,
    description: pull.body ?? ''
  }
  const input = {
    pr,
    files: files.map(({ filename, previous_filename }) => ({
      path: filename,
      previousPath: previous_filename
    })),
    reviews: reviewList,
    writers: await loadWriters({
      logins: [pr.authorLogin, ...reviewList.map(({ login }) => login)]
    }),
    config,
    headFloors: await loadHeadFloors({ files, headSha: pull.head.sha }),
    picks
  }
  const named = reviewLineToTrace(input)
  const result = decide({
    ...input,
    commits: named ? await loadCommits({ pull, named }) : null,
    merge: pull.merged ? await loadMerge({ branch: baseRef }) : undefined
  })
  console.log(JSON.stringify({ number, headSha: pr.headSha, ...result }, null, 2))

  if (pull.state === 'closed') {
    if (pull.merged) {
      const { afterMerge } = result
      await settleMerged({ action, number, labels: pr.labels, afterMerge })
    }
    return null
  }

  // A crash lets the workflow pass a PR with the emergency label (failed-run.mjs),
  // and the label never waives a missing approver color, so a comment that fails
  // keeps a failing result. A passing result still crashes, so only the emergency
  // label passes a PR whose floor comments failed.
  try {
    await postFloorComments({ number, headSha: pr.headSha, floors: result.floors })
  } catch (error) {
    if (result.state !== 'failure') throw error
    console.error(error.message)
  }
  for (const color of COLORS) {
    const label = `risk:${color}`
    if (color === result.color && !pr.labels.includes(label))
      await addLabel({ number, label })
    if (color !== result.color && pr.labels.includes(label))
      await removeLabel({ number, label })
  }
  return result
}

// A review event runs with a read-only token for a PR from a fork, so the review
// workflow only starts this one through workflow_run. That event names no PR, and
// for a PR from a fork it names the base repo as the head repo
// (change-gate-sandbox#2), so the PR is found by its head commit. A submitted
// review updates the PR, which puts it near the top of the list. A closed PR with
// the same head does not end the search: merged PRs stay in the list for their
// late approval, and an open one can be further down.
const pullsOf = async ({ event }) => {
  if (event.pull_request) {
    return [await api({ path: `/pulls/${event.pull_request.number}` })]
  }
  const run = event.workflow_run
  const covered = ({ state, base }) =>
    state === 'open' &&
    isGated({ baseRef: base.ref, defaultBranch: base.repo.default_branch })
  const found = []
  let full = true
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const pulls = await api({
      path: `/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`
    })
    found.push(...pulls.filter((pull) => pull.head.sha === run.head_sha))
    full = pulls.length === 100
    if (found.some(covered) || !full) break
  }
  if (!found.length && full) {
    throw new Error(
      `No PR with the head commit ${run.head_sha} among the ` +
        `${MAX_LIST_PAGES * 100} most recently updated PRs`
    )
  }
  return Promise.all(found.map(({ number }) => api({ path: `/pulls/${number}` })))
}

const settle = async ({ action, pull }) => {
  const defaultBranch = pull.base.repo.default_branch
  if (!isGated({ baseRef: pull.base.ref, defaultBranch })) return
  // After the merge event, only a PR that carries the label has anything to settle.
  const labelled = pull.labels.some(({ name }) => name === LABEL)
  if (pull.merged && action !== 'closed' && !labelled) return
  const open = pull.state === 'open'
  const headSha = pull.head.sha
  // Pending first: a label or review change can turn an earlier pass into a failure,
  // and the old pass must not stay mergeable while this run reads the PR.
  if (open)
    await setStatus({ sha: headSha, state: 'pending', description: 'Evaluating' })
  const others = open ? await otherPullsWithHead({ pull }) : []
  const result = others.length
    ? {
        state: 'failure',
        description: `${headSha.slice(0, 7)} is also the head of ${others.map((n) => `#${n}`).join(', ')}; open one PR per commit`
      }
    : await evaluate({ action, pull })
  if (result && open) {
    await setStatus({
      sha: headSha,
      state: result.state,
      description: result.description
    })
  }
}

// Anyone can open a PR with another PR's head, also from a fork, and that fails
// both. A PR that closes or gets a new commit leaves the head it shared, so the PRs
// still on that head get their own result back.
const settleReleased = async ({ event, pull }) => {
  const released = { closed: pull.head.sha, synchronize: event.before }[event.action]
  if (!released) return
  const left = (await paginate({ path: '/pulls' })).filter(
    (other) => other.head.sha === released && other.number !== pull.number
  )
  for (const { number } of left) {
    await settle({
      action: 'released',
      pull: await api({ path: `/pulls/${number}` })
    })
  }
}

const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
for (const pull of await pullsOf({ event })) {
  await settle({ action: event.action, pull })
  await settleReleased({ event, pull })
}
