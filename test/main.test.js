'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { handle, resolveTrigger } = require('../src/main')
const { addSignature } = require('../src/store')
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

function run(gh, eventName, event) {
  return handle({
    eventName,
    event,
    repository: 'Zipstack/unstract',
    inputs,
    gh,
    signaturesGh: gh,
    log: () => {},
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
  const result = await run(gh, 'issue_comment', commentEvent(alice, PHRASE))

  assert.equal(result.passed, true)
  assert.deepEqual(gh.state.file.data.signatures.map((s) => s.id), [alice.id])
  assert.equal(gh.state.file.data.signatures[0].pull_request, 7)
  assert.equal(gh.state.statuses.at(-1).state, 'success')
  assert.equal(gh.state.comments.length, 1, 'the existing comment is updated, not duplicated')
  assert.match(gh.state.comments[0].body, /All committers have signed/)
})

test('a commenter who is not a commit author cannot sign on someone else\'s PR', async () => {
  const gh = fakeGitHub({ pr: openPr(), commits: [commitBy(alice)] })
  const result = await run(gh, 'issue_comment', commentEvent(bob, PHRASE))

  assert.equal(result.passed, false)
  assert.equal(gh.state.file, null, 'nothing written')
  assert.equal(gh.state.statuses.at(-1).state, 'failure')
})

test('signing twice writes only once', async () => {
  const gh = fakeGitHub({ pr: openPr(), commits: [commitBy(alice)] })
  await run(gh, 'issue_comment', commentEvent(alice, PHRASE))
  await run(gh, 'issue_comment', commentEvent(alice, PHRASE))
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
  const gh = fakeGitHub({ pr: openPr(), commits: [commitBy(null)], signatures: { version: 1, signatures: [] } })
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

  await run(gh, 'issue_comment', commentEvent(bob, PHRASE))
  assert.deepEqual(gh.state.file.data.signatures.map((s) => s.login), ['bob'])
  assert.equal(gh.state.statuses.at(-1).state, 'success')
})

test('agent-authored commits by an org member pass through the member exemption', async () => {
  const gh = fakeGitHub({ pr: openPr(staff), commits: [commitBy(claudeAgent)], members: ['staff'] })
  const result = await run(gh, 'pull_request_target', prEvent)
  assert.equal(result.passed, true)
})

test('closed PRs and unrelated comments are ignored', async () => {
  const gh = fakeGitHub({ pr: { ...openPr(), state: 'closed' }, commits: [commitBy(alice)] })
  assert.equal(await run(gh, 'pull_request_target', prEvent), null)
  assert.equal(await run(gh, 'issue_comment', commentEvent(alice, 'LGTM')), null)
  assert.equal(gh.state.statuses.length, 0)
})

test('comments on plain issues are ignored', () => {
  const event = { action: 'created', issue: { number: 1 }, comment: { body: PHRASE } }
  assert.equal(resolveTrigger('issue_comment', event, PHRASE), null)
})

test('edited comments do not sign', () => {
  const event = { ...commentEvent(alice, PHRASE), action: 'edited' }
  assert.equal(resolveTrigger('issue_comment', event, PHRASE), null)
})

test('a concurrent write is retried against the latest file', async () => {
  const gh = fakeGitHub({ signatures: { version: 1, signatures: [] }, conflictsBeforeWrite: 2 })
  const location = { repository: 'Zipstack/cla-signatures', path: 'signatures.json', branch: 'main' }
  const data = await addSignature(gh, location, { id: 1, login: 'alice' })
  assert.deepEqual(data.signatures.map((s) => s.id), [1])
  assert.equal(gh.state.writes, 1)
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
