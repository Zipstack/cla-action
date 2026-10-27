'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  addPrAuthor,
  classifyAuthors,
  collectCommitAuthors,
  isSignComment,
  matchesAllowlist,
  parseList,
  renderComment,
} = require('../src/cla')
const { commitBy } = require('./fake-github')

const PHRASE = 'I have read the CLA Document and I hereby sign the CLA'

test('sign comment matches regardless of case, spacing and a trailing full stop', () => {
  assert.ok(isSignComment(PHRASE, PHRASE))
  assert.ok(isSignComment('  i have read the CLA document\nand I hereby sign the CLA. ', PHRASE))
  assert.ok(!isSignComment(`${PHRASE} but not really`, PHRASE))
  assert.ok(!isSignComment('LGTM', PHRASE))
})

test('the PR author is added once to the people who must sign', () => {
  const alice = { id: 1, login: 'alice', type: 'User' }
  const bob = { id: 2, login: 'bob', type: 'User' }
  assert.deepEqual(addPrAuthor([alice], bob), [alice, bob])
  assert.deepEqual(addPrAuthor([alice, bob], bob), [alice, bob])
})

test('allowlist supports wildcards and escapes the rest of the pattern', () => {
  const patterns = parseList('*[bot], octocat')
  assert.ok(matchesAllowlist('dependabot[bot]', patterns))
  assert.ok(matchesAllowlist('OctoCat', patterns))
  assert.ok(!matchesAllowlist('dependabotXbot', patterns))
  assert.ok(!matchesAllowlist('octocat2', patterns))
})

test('commit authors are de-duplicated and unlinked commits reported separately', () => {
  const alice = { id: 1, login: 'alice' }
  const { users, unlinked } = collectCommitAuthors([
    commitBy(alice, '1'.repeat(40)),
    commitBy(alice, '2'.repeat(40)),
    commitBy(null, '3'.repeat(40)),
  ])
  assert.deepEqual(users.map((u) => u.login), ['alice'])
  assert.deepEqual(unlinked, [{ sha: '3'.repeat(40), name: 'Someone Unlinked' }])
})

test('authors are signed, exempt (bot, allowlist, org member) or unsigned', async () => {
  const users = [
    { id: 1, login: 'signed-user', type: 'User' },
    { id: 2, login: 'renovate', type: 'Bot' },
    { id: 3, login: 'allowed', type: 'User' },
    { id: 4, login: 'staff', type: 'User' },
    { id: 5, login: 'stranger', type: 'User' },
  ]
  const result = await classifyAuthors(users, {
    signedIds: new Set([1]),
    allowlist: ['allowed'],
    isOrgMember: async (login) => login === 'staff',
  })
  assert.deepEqual(result.signed.map((u) => u.login), ['signed-user'])
  assert.deepEqual(result.exempt.map((u) => u.login), ['renovate', 'allowed', 'staff'])
  assert.deepEqual(result.unsigned.map((u) => u.login), ['stranger'])
})

test('org members are not exempt when the check is switched off', async () => {
  const result = await classifyAuthors([{ id: 4, login: 'staff', type: 'User' }], {
    signedIds: new Set(),
    allowlist: [],
    isOrgMember: null,
  })
  assert.deepEqual(result.unsigned.map((u) => u.login), ['staff'])
})

test('comment lists who must sign and the exact phrase', () => {
  const body = renderComment({
    unsigned: [{ login: 'stranger' }],
    unlinked: [],
    claUrl: 'https://example.com/cla',
    phrase: PHRASE,
  })
  assert.match(body, /zipstack-cla-action/)
  assert.match(body, /@stranger/)
  assert.ok(body.includes(PHRASE))
})

test('comment explains unlinked commits without exposing the email', () => {
  const body = renderComment({
    unsigned: [],
    unlinked: [{ sha: 'abcdef1234567', name: 'Someone' }],
    claUrl: 'https://example.com/cla',
    phrase: PHRASE,
  })
  assert.match(body, /abcdef1 \(Someone\)/)
  assert.ok(!body.includes(PHRASE))
})
