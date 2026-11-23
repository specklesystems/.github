const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID } =
  process.env
const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`

export const api = async ({ method = 'GET', path, body, raw = false }) => {
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`,
    {
      method,
      headers: {
        accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
        authorization: `Bearer ${GITHUB_TOKEN}`,
        'x-github-api-version': '2022-11-28'
      },
      body: body && JSON.stringify(body)
    }
  )
  if (!response.ok) {
    const error = new Error(
      `${method} ${path}: ${response.status} ${await response.text()}`
    )
    error.status = response.status
    throw error
  }
  if (response.status === 204) return null
  return raw ? response.text() : response.json()
}

export const paginate = async ({ path }) => {
  const items = []
  for (let page = 1; ; page++) {
    const batch = await api({ path: `${path}?per_page=100&page=${page}` })
    items.push(...batch)
    if (batch.length < 100) return items
  }
}

export const unless404 = (fallback) => (error) => {
  if (error.status === 404) return fallback
  throw error
}

export const setStatus = ({ sha, state, description }) =>
  api({
    method: 'POST',
    path: `/statuses/${sha}`,
    body: {
      context: 'risk-check',
      state,
      description: description.slice(0, 140),
      target_url: runUrl
    }
  })

export const addLabel = ({ number, label }) =>
  api({ method: 'POST', path: `/issues/${number}/labels`, body: { labels: [label] } })

export const removeLabel = ({ number, label }) =>
  api({
    method: 'DELETE',
    path: `/issues/${number}/labels/${encodeURIComponent(label)}`
  }).catch(unless404(null))
