#!/usr/bin/env node
'use strict'

// One-off migration from cla-assistant.io.
//
// Export: log in at https://cla-assistant.io with a GitHub account that has
// push access to the linked repository, open the repository's signature
// report and download "Complete History as JSON".
//
// Usage:
//   GITHUB_TOKEN=... node scripts/import-cla-assistant.js <export.json> [existing-signatures.json] > signatures.json
//
// cla-assistant records the GitHub login only, so each login is resolved to
// its numeric user id (which survives renames). Revoked signatures are
// skipped; for a login that signed more than once the earliest signature is
// kept. Logins that no longer exist are reported on stderr and skipped.

const fs = require('node:fs')
const { createClient } = require('../src/github')

async function main() {
  const [exportPath, existingPath] = process.argv.slice(2)
  if (!exportPath) throw new Error('usage: import-cla-assistant.js <export.json> [existing-signatures.json]')
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required to resolve GitHub user ids')

  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'))
  const data = existingPath
    ? JSON.parse(fs.readFileSync(existingPath, 'utf8'))
    : { version: 1, signatures: [] }
  const known = new Set(data.signatures.map((signature) => signature.id))

  const earliest = new Map()
  for (const entry of exported) {
    if (!entry.user_name || entry.revoked_at) continue
    const login = entry.user_name.toLowerCase()
    const current = earliest.get(login)
    if (!current || new Date(entry.signed_at) < new Date(current.signed_at)) earliest.set(login, entry)
  }

  const gh = createClient(process.env.GITHUB_TOKEN)
  let added = 0
  for (const entry of [...earliest.values()].sort((a, b) => new Date(a.signed_at) - new Date(b.signed_at))) {
    let user
    try {
      user = await gh.request('GET', `/users/${encodeURIComponent(entry.user_name)}`)
    } catch (error) {
      if (error.status !== 404) throw error
      console.error(`skipped ${entry.user_name}: GitHub account not found`)
      continue
    }
    if (known.has(user.id)) continue
    known.add(user.id)
    data.signatures.push({
      id: user.id,
      login: user.login,
      signed_at: new Date(entry.signed_at).toISOString(),
      cla_document: entry.gist_url,
      cla_version: entry.gist_version,
      repository: `${entry.repo_owner}/${entry.repo_name}`,
      source: 'cla-assistant.io',
    })
    added++
  }

  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
  console.error(`imported ${added} signature(s); ${data.signatures.length} in total`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
