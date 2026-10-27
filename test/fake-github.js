'use strict'

const { GitHubError } = require('../src/github')

// In-memory stand-in for the parts of the GitHub API the action uses.
function fakeGitHub({ pr, commits = [], comments = [], members = [], signatures, conflictsBeforeWrite = 0 } = {}) {
  const state = {
    pr,
    commits,
    comments: comments.map((comment) => ({ ...comment })),
    statuses: [],
    members: new Set(members),
    file: signatures === undefined ? null : { data: signatures, sha: 'sha-0' },
    writes: 0,
    conflictsBeforeWrite,
  }
  let nextId = 1000

  function encodeFile() {
    return {
      sha: state.file.sha,
      content: Buffer.from(JSON.stringify(state.file.data)).toString('base64'),
    }
  }

  async function request(method, path, body) {
    let match
    if (method === 'GET' && (match = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/))) {
      // GitHub reports the PR's full commit count, which the commits list
      // can fall short of.
      return { commits: state.commits.length, ...state.pr }
    }
    if (method === 'GET' && path.startsWith('/repos/Zipstack/cla-signatures/contents/')) {
      if (!state.file) throw new GitHubError(404, method, path, 'Not Found')
      return encodeFile()
    }
    if (method === 'PUT' && path.startsWith('/repos/Zipstack/cla-signatures/contents/')) {
      if (state.conflictsBeforeWrite > 0) {
        // Another run signs first: the file gains a signature and a new sha,
        // so this write's sha is stale.
        state.conflictsBeforeWrite--
        const concurrent = { id: 9000 + state.conflictsBeforeWrite, login: 'concurrent-signer' }
        const data = state.file ? state.file.data : { version: 1, signatures: [] }
        state.file = { data: { ...data, signatures: [...data.signatures, concurrent] }, sha: `sha-c${state.conflictsBeforeWrite}` }
      }
      // GitHub answers 409 to a stale sha and 422 to a missing sha when the
      // file already exists.
      if (state.file && !body.sha) throw new GitHubError(422, method, path, '"sha" wasn\'t supplied')
      if (state.file && body.sha !== state.file.sha) throw new GitHubError(409, method, path, 'sha mismatch')
      state.writes++
      state.file = {
        data: JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')),
        sha: `sha-${state.writes}`,
      }
      return {}
    }
    if (method === 'GET' && (match = path.match(/^\/orgs\/[^/]+\/members\/(.+)$/))) {
      if (state.members.has(decodeURIComponent(match[1]))) return null
      throw new GitHubError(404, method, path, 'Not Found')
    }
    if (method === 'POST' && path.match(/\/issues\/\d+\/comments$/)) {
      const now = new Date().toISOString()
      const comment = {
        id: nextId++,
        created_at: now,
        updated_at: now,
        user: { id: 41898282, login: 'github-actions[bot]', type: 'Bot' },
        body: body.body,
        html_url: `https://github.com/comment/${nextId}`,
      }
      state.comments.push(comment)
      return comment
    }
    if (method === 'PATCH' && (match = path.match(/\/issues\/comments\/(\d+)$/))) {
      const comment = state.comments.find((c) => c.id === Number(match[1]))
      comment.body = body.body
      return comment
    }
    if (method === 'POST' && path.match(/\/statuses\/[0-9a-f]+$/)) {
      state.statuses.push(body)
      return {}
    }
    throw new Error(`fake GitHub: unexpected ${method} ${path}`)
  }

  async function paginate(path) {
    if (path.match(/\/pulls\/\d+\/commits$/)) return state.commits
    if (path.match(/\/issues\/\d+\/comments$/)) return state.comments
    throw new Error(`fake GitHub: unexpected paginate ${path}`)
  }

  return { request, paginate, state }
}

function commitBy(user, sha = 'a'.repeat(40)) {
  return {
    sha,
    author: user ? { id: user.id, login: user.login, type: user.type || 'User' } : null,
    commit: { author: { name: user ? user.login : 'Someone Unlinked' } },
  }
}

module.exports = { commitBy, fakeGitHub }
