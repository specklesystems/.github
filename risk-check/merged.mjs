import { addLabel, api, paginate, removeLabel } from './github.mjs'

const LABEL = 'review-after-merge'

const reasonOf = (error) => (error.status ? `HTTP ${error.status}` : 'no response')

const requiredApprovals = async ({ branch }) => {
  const rules = await paginate({
    path: `/rules/branches/${encodeURIComponent(branch)}`
  })
  return Math.max(
    0,
    ...rules
      .filter(({ type }) => type === 'pull_request')
      .map(({ parameters }) => parameters?.required_approving_review_count ?? 0)
  )
}

// The activity list of this repo names who pushed the head commit to its branch.
// It holds no push to a fork, and the push can be past its first page: then the
// author and committer of the head commit stand in for the person who pushed.
const pushedBy = async ({ pull }) => {
  if (pull.head.repo?.full_name === pull.base.repo.full_name) {
    const ref = encodeURIComponent(pull.head.ref)
    const activity = await api({ path: `/activity?ref=${ref}&per_page=100` }).catch(
      () => []
    )
    const push = activity.find(({ after }) => after === pull.head.sha)
    if (push?.actor) return [push.actor.login]
  }
  const { author, committer } = await api({ path: `/commits/${pull.head.sha}` })
  return [author?.login, committer?.login].filter(Boolean)
}

// What `decide` needs as `merge`. A read that fails is not guessed: it leaves
// `unread`, which owes the review and settles none.
export const loadMerge = async ({ pull }) => {
  const unread = (what) => (error) => ({
    unread: `${what} (${reasonOf(error)})`,
    pushedBy: []
  })
  const rule = await requiredApprovals({ branch: pull.base.ref }).then(
    (count) => ({ requiredApprovals: count }),
    unread(`the rules of ${pull.base.ref}`)
  )
  if (rule.unread) return rule
  return pushedBy({ pull }).then(
    (logins) => ({ ...rule, pushedBy: logins }),
    unread('who pushed the head commit')
  )
}

export const settleMerged = async ({ action, number, labels, afterMerge }) => {
  if (!afterMerge) return
  if (action === 'closed' && afterMerge.owes) {
    await addLabel({ number, label: LABEL })
  } else if (labels.includes(LABEL) && afterMerge.reviewed) {
    await removeLabel({ number, label: LABEL })
  }
}
