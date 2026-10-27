'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createClient } = require('../src/github')

// Serves `total` numbered items in pages, as the GitHub REST API does.
function stubFetch(t, total) {
  const urls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url)
    const params = new URL(url).searchParams
    const perPage = Number(params.get('per_page'))
    const start = (Number(params.get('page')) - 1) * perPage
    const items = Array.from({ length: Math.max(0, Math.min(perPage, total - start)) }, (_, i) => start + i)
    return new Response(JSON.stringify(items), { status: 200 })
  })
  return urls
}

test('paginate follows pages until a short one', async (t) => {
  const urls = stubFetch(t, 250)
  const items = await createClient('token', 'https://api.test').paginate('/repos/o/r/pulls/1/commits')
  assert.equal(items.length, 250)
  assert.equal(urls.length, 3)
})

test('paginate stops after an exactly full last page with one empty request', async (t) => {
  const urls = stubFetch(t, 200)
  const items = await createClient('token', 'https://api.test').paginate('/x')
  assert.equal(items.length, 200)
  assert.equal(urls.length, 3)
})

test('a failed request throws with the HTTP status', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Not Found', { status: 404 }))
  await assert.rejects(createClient('token', 'https://api.test').request('GET', '/x'), (error) => error.status === 404)
})
