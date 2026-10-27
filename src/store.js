'use strict'

// Signatures live in one JSON file in a (private) repository, read and written
// through the contents API. Writes carry the blob sha, so two PRs signing at
// the same moment cannot overwrite each other: the loser gets 409, re-reads
// and tries again.

const EMPTY = { version: 1, signatures: [] }
const MAX_WRITE_ATTEMPTS = 5

function contentsPath({ repository, path }) {
  return `/repos/${repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}`
}

async function loadSignatures(gh, location) {
  try {
    const file = await gh.request('GET', `${contentsPath(location)}?ref=${encodeURIComponent(location.branch)}`)
    const data = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))
    return { data, sha: file.sha }
  } catch (error) {
    if (error.status === 404) return { data: structuredClone(EMPTY), sha: undefined }
    throw error
  }
}

function signedIds(data) {
  return new Set(data.signatures.map((signature) => signature.id))
}

// Returns the signatures after the write. Signing twice is a no-op.
async function addSignature(gh, location, record) {
  for (let attempt = 1; ; attempt++) {
    const { data, sha } = await loadSignatures(gh, location)
    if (signedIds(data).has(record.id)) return data

    data.signatures.push(record)
    const body = {
      message: `Add CLA signature for @${record.login}`,
      content: Buffer.from(`${JSON.stringify(data, null, 2)}\n`).toString('base64'),
      branch: location.branch,
    }
    if (sha) body.sha = sha

    try {
      await gh.request('PUT', contentsPath(location), body)
      return data
    } catch (error) {
      const conflict = error.status === 409 || error.status === 422
      if (!conflict || attempt >= MAX_WRITE_ATTEMPTS) throw error
    }
  }
}

module.exports = { addSignature, loadSignatures, signedIds }
