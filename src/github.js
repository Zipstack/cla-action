'use strict'

// Minimal GitHub REST client on top of the built-in fetch, so the action
// ships without a node_modules directory or a bundling step.

class GitHubError extends Error {
  constructor(status, method, path, body) {
    super(`${method} ${path} failed with ${status}: ${body}`)
    this.status = status
  }
}

function createClient(token, apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com') {
  async function request(method, path, body) {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'zipstack-cla-action',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new GitHubError(res.status, method, path, text)
    return text ? JSON.parse(text) : null
  }

  async function paginate(path) {
    const items = []
    const sep = path.includes('?') ? '&' : '?'
    for (let page = 1; ; page++) {
      const batch = await request('GET', `${path}${sep}per_page=100&page=${page}`)
      items.push(...batch)
      if (batch.length < 100) return items
    }
  }

  return { request, paginate }
}

module.exports = { createClient, GitHubError }
