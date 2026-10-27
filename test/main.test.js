'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { handle, resolveTrigger } = require('../src/main')
const { addSignature } = require('../src/store')
const { COMMENT_MARKER } = require('../src/cla')
const { commitBy, fakeGitHub } = require('./fake-github')

const PHRASE = 'I have read the CLA Document and I hereby sign the CLA'
const HEAD = 'f'.repeat(40)
const alice = { id: 11, login: 'alice', type: 'User' }
const bob = { id: 22, login: 'bob', type: 'User' }
const staff = { id: 33, login: 'staff', type: 'User' }

const inputs = {
  claDocumentUrl: 'https://example.com/cla',
  signaturesRepository: 'Zipstack/cla-signatures',
  signaturesPath: 'signatures.json',
  signaturesBranch: 'main',
  signPhrase: PHRASE,
  allowlist: ['*[bot]'],
  agentLogins: ['claude'],
  exemptOrgMembers: true,
  organization: 'Zipstack',
  statusContext: 'license/cla',
}

function openPr(author = alice) {
  return { number: 7, state: 'open', head: { sha: HEAD }, user: author }
}

const claudeAgent = { id: 81847, login: 'claude', type: 'User' }

function run(gh, eventName, event, log = () => {}) {
  return handle({
    eventName,
    event,
    repository: 'Zipstack/unstract',
    inputs,
    gh,
    signaturesGh: gh,
    log,
  })
}

const prEvent = { pull_request: { number: 7 } }
function commentEvent(user, body) {
  return {
    action: 'created',
    issue: { number: 7, pull_request: {} },
    comment: { user, body, html_url: 'https://github.com/Zipstack/unstract/pull/7#c1' },
  }
}

// Posts a comment on the PR and runs the action for it, as GitHub would.
let nextCommentId = 1
function postComment(gh, user, body, { editedAt } = {}) {
  const id = nextCommentId++
  // GitHub's timestamps have no milliseconds.
  const createdAt = new Date(Date.UTC(2026, 9, 1, 0, id)).toISOString().replace('.000Z', 'Z')
  gh.state.comments.push({
    id,
    user,
    body,
    created_at: createdAt,
    updated_at: editedAt || createdAt,
    html_url: `https://github.com/Zipstack/unstract/pull/7#issuecomment-${id}`,
  })
  return gh.state.comments.at(-1)
}
function comment(gh, user, body) {
  postComment(gh, user, body)
  return run(gh, 'issue_comment', commentEvent(user, body))
}

test('unsigned author: failure status and a comment asking them to sign', async () => {
  const gh = fakeGitHub({ pr: openPr(), commits: [commitBy(alice)] })
  const result = await run(gh, 'pull_request_target', prEvent)

  assert.equal(result.passed, false)
  assert.equal(gh.state.statuses.length, 1)
  assert.equal(gh.state.statuses[0].state, 'failure')
  assert.equal(gh.state.statuses[0].context, 'license/cla')
  assert.equal(gh.state.comments.length, 1)
  assert.match(gh.state.comments[0].body, /@alice/)
})

test('signing by comment records the signature and flips the status to success', async () => {
  const gh = fakeGitHub({ pr: openPr(), commits: [commitBy(alice)] })
  await run(gh, 'pull_request_target', prEvent)
  const result = await comment(gh, alice, PHRASE)

  assert.equal(result.passed, true)
  assert.deepEqual(gh.state.file.data.signatures.map((s) => s.id), [alice.id])
  assert.equal(gh.state.file.data.signatures[0].pull_request, 7)
  assert.equal(gh.state.statuses.at(-1).state, 'success')
  const botComments = gh.state.comments.filter((c) => c.body.includes(COMMENT_MARKER))
  assert.equal(botComments.length, 1, 'the existing comment is updated, not duplicated')
  assert.match(botComments[0].body, /All committers have signed/)
})

test('a commenter who is not a commit author cannot sign on someone else\'s PR', async () => {
  const gh = fakeGitHub({ pr: openPr(), commits: [commitBy(alice)] })
  const result = await comment(gh, bob, PHRASE)

  assert.equal(result.passed, false)
  assert.equal(gh.state.file, null, 'nothing written')
  assert.equal(gh.state.statuses.at(-1).state, 'failure')
})

test('signing twice writes only once', async () => {
  const gh = fakeGitHub({ pr: openPr(), commits: [commitBy(alice)] })
  await comment(gh, alice, PHRASE)
  await comment(gh, alice, PHRASE)
  assert.equal(gh.state.writes, 1)
})

test('already-signed, org-member and bot authors pass without a comment', async () => {
  const gh = fakeGitHub({
    pr: openPr(),
    commits: [commitBy(alice), commitBy(staff), commitBy({ id: 99, login: 'dependabot[bot]', type: 'Bot' })],
    members: ['staff'],
    signatures: { version: 1, signatures: [{ id: alice.id, login: 'alice' }] },
  })
  const result = await run(gh, 'pull_request_target', prEvent)

  assert.equal(result.passed, true)
  assert.equal(gh.state.statuses[0].state, 'success')
  assert.equal(gh.state.comments.length, 0)
})

test('a commit with no linked GitHub account keeps the check failing', async () => {
  const gh = fakeGitHub({
    pr: openPr(staff),
    commits: [commitBy(null)],
    members: ['staff'],
    signatures: { version: 1, signatures: [] },
  })
  const result = await run(gh, 'pull_request_target', prEvent)
  assert.equal(result.passed, false)
  assert.match(gh.state.statuses[0].description, /1 committer still needs/)
})

test('agent-authored commits require the PR author to sign, not the agent', async () => {
  const gh = fakeGitHub({ pr: openPr(bob), commits: [commitBy(claudeAgent)] })
  const result = await run(gh, 'pull_request_target', prEvent)

  assert.equal(result.passed, false)
  assert.deepEqual(result.unsigned.map((u) => u.login), ['bob'])
  assert.doesNotMatch(gh.state.comments[0].body, /@claude/)

  await comment(gh, bob, PHRASE)
  assert.deepEqual(gh.state.file.data.signatures.map((s) => s.login), ['bob'])
  assert.equal(gh.state.statuses.at(-1).state, 'success')
})

test('agent-authored commits by an org member pass through the member exemption', async () => {
  const gh = fakeGitHub({ pr: openPr(staff), commits: [commitBy(claudeAgent)], members: ['staff'] })
  const result = await run(gh, 'pull_request_target', prEvent)
  assert.equal(result.passed, true)
})

test('closed PRs are ignored', async () => {
  const gh = fakeGitHub({ pr: { ...openPr(), state: 'closed' }, commits: [commitBy(alice)] })
  assert.equal(await run(gh, 'pull_request_target', prEvent), null)
  assert.equal(await comment(gh, alice, PHRASE), null)
  assert.equal(gh.state.statuses.length, 0)
  assert.equal(gh.state.file, null)
})

test('a sign comment whose own run was cancelled is recorded by the next run', async () => {
  // The concurrency group cancels a pending run when another is queued, so the
  // sign comment's run may never execute. Any later run must pick it up.
  const gh = fakeGitHub({ pr: openPr(), commits: [commitBy(alice)] })
  const signed = postComment(gh, alice, PHRASE)
  const result = await comment(gh, bob, 'LGTM')

  assert.equal(result.passed, true)
  assert.deepEqual(gh.state.file.data.signatures.map((s) => s.id), [alice.id])
  assert.equal(gh.state.file.data.signatures[0].comment_url, signed.html_url)
  assert.equal(
    gh.state.file.data.signatures[0].signed_at,
    new Date(signed.created_at).toISOString(),
    'signed when the comment was posted',
  )
  assert.equal(gh.state.statuses.at(-1).state, 'success')
})

test('the PR author must sign even when every commit is attributed to an exempt account', async () => {
  // Commit authors are matched by email, which the committer chooses.
  const botAccount = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' }
  const gh = fakeGitHub({
    pr: openPr(bob),
    commits: [commitBy(botAccount), commitBy(staff)],
    members: ['staff'],
    signatures: { version: 1, signatures: [] },
  })
  const result = await run(gh, 'pull_request_target', prEvent)

  assert.equal(result.passed, false)
  assert.deepEqual(result.unsigned.map((u) => u.login), ['bob'])

  await comment(gh, bob, PHRASE)
  assert.deepEqual(gh.state.file.data.signatures.map((s) => s.login), ['bob'])
  assert.equal(gh.state.statuses.at(-1).state, 'success')
})

test('a PR with more commits than GitHub lists fails instead of passing on a partial list', async () => {
  const gh = fakeGitHub({
    pr: { ...openPr(), commits: 300 },
    commits: [commitBy(alice)],
    signatures: { version: 1, signatures: [{ id: alice.id, login: 'alice' }] },
  })
  const result = await run(gh, 'pull_request_target', prEvent)

  assert.equal(result.passed, false)
  assert.equal(gh.state.statuses[0].state, 'failure')
  assert.match(gh.state.statuses[0].description, /300 commits/)
  assert.match(gh.state.comments[0].body, /more commits than GitHub lists/)
})

test('comments on plain issues are ignored', () => {
  const event = { action: 'created', issue: { number: 1 }, comment: { body: PHRASE } }
  assert.equal(resolveTrigger('issue_comment', event), null)
})

test('edited comments do not sign', async () => {
  const event = { ...commentEvent(alice, PHRASE), action: 'edited' }
  assert.equal(resolveTrigger('issue_comment', event), null)

  // Nor does a later run pick up a comment that was edited into the phrase.
  const gh = fakeGitHub({ pr: openPr(), commits: [commitBy(alice)] })
  const edited = postComment(gh, alice, PHRASE, { editedAt: '2026-10-20T00:00:00Z' })
  postComment(gh, bob, 'LGTM')
  const logs = []
  const result = await run(gh, 'issue_comment', commentEvent(bob, 'LGTM'), (line) => logs.push(line))
  assert.equal(result.passed, false)
  assert.equal(gh.state.file, null, 'nothing written')
  assert.ok(logs.some((line) => line.includes(edited.html_url) && line.includes('@alice')), 'the log names the ignored comment')

  // Posting the phrase again as a new comment signs.
  const fresh = postComment(gh, alice, PHRASE)
  const retry = await comment(gh, bob, 'thanks')
  assert.equal(retry.passed, true)
  assert.deepEqual(gh.state.file.data.signatures.map((s) => s.id), [alice.id])
  assert.equal(gh.state.file.data.signatures[0].signed_at, new Date(fresh.created_at).toISOString())

  // Once signed, the old edited comment no longer tells them to post again.
  const later = []
  await run(gh, 'issue_comment', commentEvent(bob, 'ok'), (line) => later.push(line))
  assert.ok(!later.some((line) => line.includes(edited.html_url)), 'no repost advice after signing')
})

test('a PR whose commit count matches the listed commits is not treated as truncated', async () => {
  const gh = fakeGitHub({
    pr: { ...openPr(), commits: 2 },
    commits: [commitBy(alice, '1'.repeat(40)), commitBy(alice, '2'.repeat(40))],
    signatures: { version: 1, signatures: [{ id: alice.id, login: 'alice' }] },
  })
  const result = await run(gh, 'pull_request_target', prEvent)
  assert.equal(result.truncated, false)
  assert.equal(result.passed, true)
})

test('a concurrent write is retried against the latest file, keeping the other signatures', async () => {
  const gh = fakeGitHub({ signatures: { version: 1, signatures: [] }, conflictsBeforeWrite: 2 })
  const location = { repository: 'Zipstack/cla-signatures', path: 'signatures.json', branch: 'main' }
  const data = await addSignature(gh, location, { id: 1, login: 'alice' })
  assert.deepEqual(data.signatures.map((s) => s.id), [9001, 9000, 1])
  assert.deepEqual(gh.state.file.data.signatures.map((s) => s.id), [9001, 9000, 1])
  assert.equal(gh.state.writes, 1)
})

test('two first signatures at once: the one that finds the file already created retries', async () => {
  // Both runs saw no file; the other creates it first, so this write has no
  // sha and GitHub answers 422.
  const gh = fakeGitHub({ conflictsBeforeWrite: 1 })
  const location = { repository: 'Zipstack/cla-signatures', path: 'signatures.json', branch: 'main' }
  const data = await addSignature(gh, location, { id: 1, login: 'alice' })
  assert.deepEqual(data.signatures.map((s) => s.id), [9000, 1])
  assert.deepEqual(gh.state.file.data.signatures.map((s) => s.id), [9000, 1])
})

test('a signature recorded by a concurrent run is not written again', async () => {
  const gh = fakeGitHub({ signatures: { version: 1, signatures: [{ id: 1, login: 'alice' }] } })
  const location = { repository: 'Zipstack/cla-signatures', path: 'signatures.json', branch: 'main' }
  const data = await addSignature(gh, location, { id: 1, login: 'alice' })
  assert.equal(data.signatures.length, 1)
  assert.equal(gh.state.writes, 0)
})

test('a write that keeps conflicting gives up instead of looping', async () => {
  const gh = fakeGitHub({ signatures: { version: 1, signatures: [] }, conflictsBeforeWrite: 99 })
  const location = { repository: 'Zipstack/cla-signatures', path: 'signatures.json', branch: 'main' }
  await assert.rejects(addSignature(gh, location, { id: 1, login: 'alice' }), /409/)
})
