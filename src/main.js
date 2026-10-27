'use strict'

const {
  COMMENT_MARKER,
  attributeToPrAuthor,
  classifyAuthors,
  collectCommitAuthors,
  isRecheckComment,
  isSignComment,
  renderComment,
} = require('./cla')
const { addSignature, loadSignatures, signedIds } = require('./store')

// Works out which PR the event is about and whether the commenter is signing.
// Returns null when the event needs no action.
function resolveTrigger(eventName, event, phrase) {
  if (eventName === 'pull_request_target' || eventName === 'pull_request') {
    return { prNumber: event.pull_request.number, signer: null }
  }
  if (eventName === 'issue_comment') {
    if (event.action !== 'created' || !event.issue.pull_request) return null
    const body = event.comment.body
    if (isSignComment(body, phrase)) {
      return { prNumber: event.issue.number, signer: event.comment.user, comment: event.comment }
    }
    if (isRecheckComment(body)) return { prNumber: event.issue.number, signer: null }
    return null
  }
  throw new Error(`Unsupported event "${eventName}". Trigger on pull_request_target and issue_comment.`)
}

async function upsertComment(gh, repository, prNumber, body, { createIfMissing }) {
  const comments = await gh.paginate(`/repos/${repository}/issues/${prNumber}/comments`)
  const existing = comments.find((comment) => comment.body && comment.body.includes(COMMENT_MARKER))
  if (existing) {
    if (existing.body === body) return existing
    return gh.request('PATCH', `/repos/${repository}/issues/comments/${existing.id}`, { body })
  }
  if (!createIfMissing) return null
  return gh.request('POST', `/repos/${repository}/issues/${prNumber}/comments`, { body })
}

async function handle({ eventName, event, repository, inputs, gh, signaturesGh, log }) {
  const trigger = resolveTrigger(eventName, event, inputs.signPhrase)
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
  const authors = collectCommitAuthors(commits)
  const users = attributeToPrAuthor(authors.users, inputs.agentLogins, pr.user)
  const unlinked = authors.unlinked
  const location = {
    repository: inputs.signaturesRepository,
    path: inputs.signaturesPath,
    branch: inputs.signaturesBranch,
  }

  let { data } = await loadSignatures(signaturesGh, location)
  const signer = trigger.signer
  if (signer && !signedIds(data).has(signer.id)) {
    if (users.some((user) => user.id === signer.id)) {
      data = await addSignature(signaturesGh, location, {
        id: signer.id,
        login: signer.login,
        signed_at: new Date().toISOString(),
        cla_document: inputs.claDocumentUrl,
        repository,
        pull_request: pr.number,
        comment_url: trigger.comment.html_url,
      })
      log(`Recorded signature for @${signer.login}.`)
    } else {
      log(`@${signer.login} is not a commit author on PR #${pr.number}; not recording a signature.`)
    }
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
  const passed = result.unsigned.length === 0 && unlinked.length === 0
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
    renderComment({ ...result, unlinked, claUrl: inputs.claDocumentUrl, phrase: inputs.signPhrase }),
    { createIfMissing: !passed },
  )

  const pending = result.unsigned.length + unlinked.length
  await gh.request('POST', `/repos/${repository}/statuses/${pr.head.sha}`, {
    state: passed ? 'success' : 'failure',
    context: inputs.statusContext,
    description: passed
      ? 'All committers have signed the CLA.'
      : `${pending} committer${pending === 1 ? '' : 's'} still need${pending === 1 ? 's' : ''} to sign the CLA.`,
    target_url: comment ? comment.html_url : inputs.claDocumentUrl,
  })

  return { passed, ...result, unlinked }
}

module.exports = { handle, resolveTrigger }
