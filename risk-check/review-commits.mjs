import { api, paginate, unlessMissing } from './github.mjs'
import { MAX_TRACED } from './review-line.mjs'

const isOnBase = async ({ base, sha }) => {
  const comparison = await api({
    path: `/compare/${encodeURIComponent(base)}...${sha}`
  }).catch(unlessMissing(null))
  return comparison?.ahead_by === 0
}

// What `decide` needs as `commits`. The check compares one parent at a time, and
// stops at the first commit after the named one that is no merge of the base
// branch. It compares nothing when the line fails anyway: too many commits after
// the named one, or a list short of the head.
export const loadCommits = async ({ pull, named }) => {
  const commits = (await paginate({ path: `/pulls/${pull.number}/commits` })).map(
    ({ sha, parents }) => ({
      sha,
      parents: parents.map((parent) => ({ sha: parent.sha, onBase: false }))
    })
  )
  const later = commits.slice(commits.findIndex(({ sha }) => sha.startsWith(named)) + 1)
  const traceable =
    later.length < commits.length &&
    later.length <= MAX_TRACED &&
    commits.at(-1).sha === pull.head.sha
  if (!traceable) return commits
  for (const { parents } of later) {
    for (const parent of parents.slice(1)) {
      parent.onBase = await isOnBase({ base: pull.base.ref, sha: parent.sha })
      if (parent.onBase) break
    }
    if (!parents.some(({ onBase }) => onBase)) break
  }
  return commits
}
