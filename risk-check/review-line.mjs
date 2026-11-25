const LINE = /^Reviewed at\s+`?([0-9a-fA-F]{7,40})`?$/

export const reviewedCommit = (description) => {
  const last = (description ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  const match = LINE.exec(last ?? '')
  return match ? match[1].toLowerCase() : null
}

// A merge of the base branch after the review brings in only commits that passed
// this gate on the base, so it needs no new review. The pr skill merges the base
// before it opens a PR and keeps the line it wrote before that merge.
const mergesBase = ({ parents }) =>
  parents.length >= 2 && parents.slice(1).some(({ onBase }) => onBase)

// `commits` lists the commits of the PR, oldest first, each with its parents and
// whether the base branch holds each one. It is null when the check read none.
export const reviewLineProblem = ({ pr, commits }) => {
  const head = pr.headSha.slice(0, 7)
  const named = reviewedCommit(pr.description)
  if (!named) {
    return `The description must end with "Reviewed at ${head}" (the pr skill writes it)`
  }
  if (pr.headSha.startsWith(named)) return null
  const index = (commits ?? []).findIndex(({ sha }) => sha.startsWith(named))
  if (index >= 0 && commits.slice(index + 1).every(mergesBase)) return null
  return (
    `The description ends with "Reviewed at ${named.slice(0, 7)}"; the newest commit ` +
    `is ${head}. Review it, then end with "Reviewed at ${head}"`
  )
}
