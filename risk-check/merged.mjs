import { addLabel, api, paginate, removeLabel } from './github.mjs'

export const LABEL = 'review-after-merge'

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
// `unread`, which owes the review and settles none. The pusher only counts against
// a required approval, an emergency or a label at stake, so a risk-based merge
// that passed reads none and gets no label from it.
export const loadMerge = async ({ pull, pusherMatters }) => {
  const unread = (what, reason) => ({ unread: `${what} (${reason})`, pushedBy: [] })
  const rule = await requiredApprovals({ branch: pull.base.ref }).then(
    (count) => ({ requiredApprovals: count }),
    (error) => unread(`the rules of ${pull.base.ref}`, reasonOf(error))
  )
  if (rule.unread) return rule
  if (!rule.requiredApprovals && !pusherMatters) return { ...rule, pushedBy: [] }
  const pusher = 'who pushed the head commit'
  return pushedBy({ pull }).then(
    (logins) =>
      logins.length
        ? { ...rule, pushedBy: logins }
        : unread(pusher, 'no login on the head commit'),
    (error) => unread(pusher, reasonOf(error))
  )
}

// A merge that got past the rules must not leave the weekly list because its
// evaluation could not finish.
export const oweReview = async ({ number, reason }) => {
  console.log(`#${number} gets ${LABEL}: ${reason}`)
  await addLabel({ number, label: LABEL })
}

// One rule on every event of a merged PR, so a run that replaces the run of the
// merge still records it and a removed label comes back. Only the review takes the
// label off: removing the emergency label afterwards must not clear the debt.
export const settleMerged = async ({ number, labels, afterMerge }) => {
  if (afterMerge.owes && !afterMerge.reviewed && !labels.includes(LABEL)) {
    await oweReview({ number, reason: afterMerge.reasons.join('; ') })
  } else if (afterMerge.reviewed && labels.includes(LABEL)) {
    await removeLabel({ number, label: LABEL })
  }
}
