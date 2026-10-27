'use strict'

const {
  COMMENT_MARKER,
  addPrAuthor,
  attributeToPrAuthor,
  classifyAuthors,
  collectCommitAuthors,
  isSignComment,
  renderComment,
} = require('./cla')
const { addSignature, loadSignatures, signedIds } = require('./store')

// Works out which PR the event is about. Returns null when the event needs no
// action.
//
// Every PR comment runs the whole check, not just sign and `recheck` comments.
// The workflow's concurrency group keeps only one pending run per PR and
// cancels the one already pending, so a sign comment's run can be replaced by
// a later comment's run. Each run therefore does all the work, including
// recording sign comments it finds on the PR, so the run that replaced a
// cancelled one does what the cancelled one would have done.
function resolveTrigger(eventName, event) {
  if (eventName === 'pull_request_target' || eventName === 'pull_request') {
    return { prNumber: event.pull_request.number }
  }
  if (eventName === 'issue_comment') {
    if (event.action !== 'created' || !event.issue.pull_request) return null
    return { prNumber: event.issue.number }
  }
  throw new Error(`Unsupported event "${eventName}". Trigger on pull_request_target and issue_comment.`)
}

async function upsertComment(gh, repository, prNumber, comments, body, { createIfMissing }) {
  const existing = comments.find((comment) => comment.body && comment.body.includes(COMMENT_MARKER))
  if (existing) {
    if (existing.body === body) return existing
    return gh.request('PATCH', `/repos/${repository}/issues/comments/${existing.id}`, { body })
  }
  if (!createIfMissing) return null
  return gh.request('POST', `/repos/${repository}/issues/${prNumber}/comments`, { body })
}

async function handle({ eventName, event, repository, inputs, gh, signaturesGh, log }) {
  const trigger = resolveTrigger(eventName, event)
  if (!trigger) {
    log('Nothing to do for this event.')
    return null
  }

  const pr = await gh.request('GET', `/repos/${repository}/pulls/${trigger.prNumber}`)
  if (pr.state !== 'open') {
    log(`PR #${pr.number} is ${pr.state}; skipping.`)
    return null
  }

  const commits = await gh.paginate(`/repos/${repository}/pulls/${pr.number}/commits`)
  // The PR commits endpoint returns at most 250 commits. Authors beyond that
  // are never seen, so a PR longer than that fails rather than passing on a
  // partial list.
  const truncated = commits.length < pr.commits
  const authors = collectCommitAuthors(commits)
  const users = addPrAuthor(attributeToPrAuthor(authors.users, inputs.agentLogins, pr.user), pr.user)
  const unlinked = authors.unlinked
  const location = {
    repository: inputs.signaturesRepository,
    path: inputs.signaturesPath,
    branch: inputs.signaturesBranch,
  }

  // Signatures come from every sign comment on the PR, not only the one that
  // triggered this run (see resolveTrigger). Only a commit author or the PR
  // author can sign; the earliest sign comment per person is recorded. An
  // edited comment never signs: people with write access can edit anyone's
  // comment, so its text may not be what its author wrote.
  const comments = await gh.paginate(`/repos/${repository}/issues/${pr.number}/comments`)
  let { data } = await loadSignatures(signaturesGh, location)
  const required = new Set(users.map((user) => user.id))
  const handled = new Set()
  for (const comment of comments) {
    const signer = comment.user
    if (!signer || handled.has(signer.id) || comment.updated_at !== comment.created_at) continue
    if (!isSignComment(comment.body, inputs.signPhrase)) continue
    handled.add(signer.id)
    if (signedIds(data).has(signer.id)) continue
    if (!required.has(signer.id)) {
      log(`@${signer.login} is not a commit author or the author of PR #${pr.number}; not recording a signature.`)
      continue
    }
    data = await addSignature(signaturesGh, location, {
      id: signer.id,
      login: signer.login,
      signed_at: comment.created_at,
      cla_document: inputs.claDocumentUrl,
      repository,
      pull_request: pr.number,
      comment_url: comment.html_url,
    })
    log(`Recorded signature for @${signer.login}.`)
  }

  const org = inputs.organization
  const isOrgMember = inputs.exemptOrgMembers
    ? async (login) => {
        try {
          await signaturesGh.request('GET', `/orgs/${org}/members/${encodeURIComponent(login)}`)
          return true
        } catch (error) {
          if (error.status === 404) return false
          throw error
        }
      }
    : null

  const result = await classifyAuthors(users, {
    signedIds: signedIds(data),
    allowlist: inputs.allowlist,
    isOrgMember,
  })
  const passed = result.unsigned.length === 0 && unlinked.length === 0 && !truncated
  if (truncated) log(`PR #${pr.number} has ${pr.commits} commits; only the first ${commits.length} can be listed.`)
  log(
    `signed: ${result.signed.map((u) => u.login).join(', ') || '-'}; ` +
      `exempt: ${result.exempt.map((u) => u.login).join(', ') || '-'}; ` +
      `unsigned: ${result.unsigned.map((u) => u.login).join(', ') || '-'}; ` +
      `unlinked commits: ${unlinked.length}`,
  )

  const comment = await upsertComment(
    gh,
    repository,
    pr.number,
    comments,
    renderComment({ ...result, unlinked, truncated, claUrl: inputs.claDocumentUrl, phrase: inputs.signPhrase }),
    { createIfMissing: !passed },
  )

  const pending = result.unsigned.length + unlinked.length
  await gh.request('POST', `/repos/${repository}/statuses/${pr.head.sha}`, {
    state: passed ? 'success' : 'failure',
    context: inputs.statusContext,
    description: passed
      ? 'All committers have signed the CLA.'
      : truncated
        ? `PR has ${pr.commits} commits; only ${commits.length} can be checked. Split it into smaller PRs.`
        : `${pending} committer${pending === 1 ? '' : 's'} still need${pending === 1 ? 's' : ''} to sign the CLA.`,
    target_url: comment ? comment.html_url : inputs.claDocumentUrl,
  })

  return { passed, ...result, unlinked, truncated }
}

module.exports = { handle, resolveTrigger }
