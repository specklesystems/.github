const PICK_LINE = /^\(cherry picked from commit ([0-9a-f]{40})\)$/gm

export const pickedFrom = (message) =>
  [...message.matchAll(PICK_LINE)].at(-1)?.[1] ?? null

export const isGated = ({ baseRef, defaultBranch }) =>
  [defaultBranch, 'main', 'dev'].includes(baseRef) || baseRef.startsWith('hotfix-')

// A hunk header holds line numbers, and those differ between two branches that got
// the same change.
const changeOf = (patch) =>
  patch
    .split('\n')
    .map((line) => (line.startsWith('@@') ? '@@' : line))
    .join('\n')

// GitHub sends no patch for a binary file, a very large file or a rename with no
// edit. Such a file cannot be compared, so the PR follows the normal rules.
const sameFile = ({ copy, source }) =>
  copy.status === source.status &&
  copy.previousPath === source.previousPath &&
  copy.patch != null &&
  source.patch != null &&
  changeOf(copy.patch) === changeOf(source.patch)

// The line that `git cherry-pick -x` writes names a source commit, but anyone can
// type that line. Only an equal change proves that the commit is a copy.
export const sameChange = ({ copy, source }) =>
  Boolean(copy && source) &&
  copy.length === source.length &&
  copy.every((file) => {
    const other = source.find(({ path }) => path === file.path)
    return other !== undefined && sameFile({ copy: file, source: other })
  })

// `pr.headGated` and `pick.sourceGated` say that the branch requires risk-check in
// GitHub's live rules, so each change on it already went through this gate.
export const movesMergedChanges = ({ pr, picks }) => {
  if (pr.fromFork) return false
  if (pr.baseRef === 'main' && pr.headRef === 'dev') return pr.headGated
  return (
    pr.baseRef.startsWith('hotfix-') &&
    picks.length > 0 &&
    picks.every((pick) => pick.sourceGated && sameChange(pick))
  )
}
