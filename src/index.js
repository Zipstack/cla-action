'use strict'

const fs = require('node:fs')
const { parseList } = require('./cla')
const { createClient } = require('./github')
const { handle } = require('./main')

// Same lookup as @actions/core getInput: INPUT_<NAME> with spaces as underscores.
function input(name, { required = false } = {}) {
  const value = (process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] || '').trim()
  if (required && !value) throw new Error(`Input required and not supplied: ${name}`)
  return value
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY
  const inputs = {
    claDocumentUrl: input('cla-document-url', { required: true }),
    signaturesRepository: input('signatures-repository', { required: true }),
    signaturesPath: input('signatures-path') || 'signatures.json',
    signaturesBranch: input('signatures-branch') || 'main',
    signPhrase: input('sign-phrase', { required: true }),
    allowlist: parseList(input('allowlist')),
    agentLogins: parseList(input('agent-logins')),
    exemptOrgMembers: input('exempt-org-members') !== 'false',
    organization: input('organization') || repository.split('/')[0],
    statusContext: input('status-context') || 'license/cla',
  }

  const result = await handle({
    eventName: process.env.GITHUB_EVENT_NAME,
    event: JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    repository,
    inputs,
    gh: createClient(input('github-token', { required: true })),
    signaturesGh: createClient(input('signatures-token', { required: true })),
    log: console.log,
  })

  // The CLA outcome is reported through the commit status, which is what branch
  // protection requires. The job itself only fails when the action breaks.
  if (result && !result.passed) console.log('CLA not yet signed by every committer; status set to failure.')
}

main().catch((error) => {
  console.log(`::error::${error.message}`)
  process.exitCode = 1
})
