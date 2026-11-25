import { addLabel, paginate, removeLabel } from './github.mjs'

export const LABEL = 'review-after-merge'

// What `decide` needs as `merge`. Rules that cannot be read give null, which owes
// the review and settles none.
export const loadMerge = async ({ branch }) => {
  const rules = await paginate({
    path: `/rules/branches/${encodeURIComponent(branch)}`
  }).catch(() => null)
  const counts = (rules ?? [])
    .filter(({ type }) => type === 'pull_request')
    .map(({ parameters }) => parameters?.required_approving_review_count ?? 0)
  return { requiredApprovals: rules && Math.max(0, ...counts) }
}

// Only the merge event adds the label; a later event only takes it off, once the
// review is in.
export const settleMerged = async ({ action, number, labels, afterMerge }) => {
  const present = labels.includes(LABEL)
  if (action === 'closed') {
    if (afterMerge.owes && !present) await addLabel({ number, label: LABEL })
  } else if (afterMerge.reviewed && present) {
    await removeLabel({ number, label: LABEL })
  }
}
