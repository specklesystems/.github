import { api, paginate } from './github.mjs'
import { reviewedCommit } from './review-line.mjs'

const FLOORS_FILE = '.github/risk-floors.yml'
const { GITHUB_REPOSITORY, HEAD_SHA } = process.env

// A PR that changes the floors file can make the run fail on purpose, so it gets
// no pass; nor does a PR whose changed files the check cannot list in full. The
// normal gate does not waive the code review line, so neither does this pass.
const passes = async ({ number, head, labels }) => {
  if (head.repo?.full_name !== GITHUB_REPOSITORY) return false
  if (!labels.some(({ name }) => name === 'emergency')) return false
  const [{ changed_files, body }, files] = await Promise.all([
    api({ path: `/pulls/${number}` }),
    paginate({ path: `/pulls/${number}/files` })
  ])
  const reviewed = reviewedCommit(body)
  return (
    Boolean(reviewed && head.sha.startsWith(reviewed)) &&
    files.length >= changed_files &&
    !files.some(({ filename, previous_filename }) =>
      [filename, previous_filename].includes(FLOORS_FILE)
    )
  )
}

const emergencyPass = async () => {
  const pulls = (await paginate({ path: '/pulls' })).filter(
    ({ head }) => head.sha === HEAD_SHA
  )
  for (const pull of pulls) if (!(await passes(pull))) return false
  return pulls.length > 0
}

console.log(
  String(
    await emergencyPass().catch((error) => {
      console.error(error.message)
      return false
    })
  )
)
