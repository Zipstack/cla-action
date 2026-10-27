'use strict'

// Pure logic: deciding who must sign and rendering the PR comment.
// Nothing in this file talks to GitHub.

const COMMENT_MARKER = '<!-- zipstack-cla-action -->'

function normalize(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '')
    .toLowerCase()
}

function isSignComment(body, phrase) {
  return normalize(body) === normalize(phrase)
}

function isRecheckComment(body) {
  return normalize(body) === 'recheck'
}

function parseList(value) {
  return String(value || '')
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

// Patterns are GitHub logins, optionally with `*` wildcards (e.g. `*[bot]`).
function matchesAllowlist(login, patterns) {
  return patterns.some((pattern) => {
    const escaped = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`).test(login.toLowerCase())
  })
}

// Commit authors of a PR. A commit whose author email is not linked to a
// GitHub account has no `author` object; that person cannot sign until they
// link the email, so they are reported separately.
function collectCommitAuthors(commits) {
  const users = new Map()
  const unlinked = []
  for (const commit of commits) {
    if (commit.author && commit.author.id) {
      users.set(commit.author.id, {
        id: commit.author.id,
        login: commit.author.login,
        type: commit.author.type,
      })
    } else {
      unlinked.push({ sha: commit.sha, name: commit.commit.author.name })
    }
  }
  return { users: [...users.values()], unlinked }
}

// Commits made by a coding agent (e.g. Claude Code commits as the `claude`
// account) are the PR author's contribution, so the PR author is the one who
// must sign for them. Allowlisting the agent instead would let anyone skip the
// CLA by having the agent make every commit.
function attributeToPrAuthor(users, agentLogins, prAuthor) {
  const agents = new Set(agentLogins.map((login) => login.toLowerCase()))
  const result = new Map()
  for (const user of users) {
    const owner = agents.has(user.login.toLowerCase())
      ? { id: prAuthor.id, login: prAuthor.login, type: prAuthor.type }
      : user
    result.set(owner.id, owner)
  }
  return [...result.values()]
}

async function classifyAuthors(users, { signedIds, allowlist, isOrgMember }) {
  const result = { signed: [], exempt: [], unsigned: [] }
  for (const user of users) {
    if (signedIds.has(user.id)) {
      result.signed.push(user)
    } else if (user.type === 'Bot' || matchesAllowlist(user.login, allowlist)) {
      result.exempt.push(user)
    } else if (isOrgMember && (await isOrgMember(user.login))) {
      result.exempt.push(user)
    } else {
      result.unsigned.push(user)
    }
  }
  return result
}

function renderComment({ unsigned, unlinked, claUrl, phrase }) {
  if (unsigned.length === 0 && unlinked.length === 0) {
    return `${COMMENT_MARKER}\n✅ All committers have signed the [CLA](${claUrl}). Thank you!`
  }

  const lines = [
    COMMENT_MARKER,
    `Thank you for your contribution! Before we can merge it, every committer needs to sign our [Contributor License Agreement](${claUrl}).`,
    '',
  ]
  if (unsigned.length > 0) {
    lines.push(
      'To sign, read the CLA and then post a comment on this pull request with exactly this text:',
      '',
      '```',
      phrase,
      '```',
      '',
      'Still to sign:',
      ...unsigned.map((user) => `- [ ] @${user.login}`),
      '',
    )
  }
  if (unlinked.length > 0) {
    lines.push(
      'These commits use an email address that is not linked to any GitHub account, so their author cannot sign. ' +
        '[Add the email to your GitHub account](https://github.com/settings/emails), or amend the commits to use a linked email, then comment `recheck`.',
      '',
      ...unlinked.map((commit) => `- ${commit.sha.slice(0, 7)} (${commit.name})`),
      '',
    )
  }
  lines.push('<sub>Already signed? Comment `recheck` to run the check again.</sub>')
  return lines.join('\n')
}

module.exports = {
  COMMENT_MARKER,
  attributeToPrAuthor,
  classifyAuthors,
  collectCommitAuthors,
  isRecheckComment,
  isSignComment,
  matchesAllowlist,
  parseList,
  renderComment,
}
