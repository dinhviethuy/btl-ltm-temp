import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'
import { createExternalLinkHandler } from '../src/main/external-links.ts'

test('opens only HTTP/HTTPS links and denies every new Electron window', async () => {
  const opened: string[] = []
  const handler = createExternalLinkHandler(async (url) => { opened.push(url) })
  for (const url of ['https://example.com/docs?q=1', 'http://localhost:3000', 'file:///C:/Windows/system32/cmd.exe', 'javascript:alert(1)', 'ftp://example.com/file', 'mailto:a@example.com', 'custom:launch', 'not a URL']) {
    assert.deepEqual(handler({ url }), { action: 'deny' })
  }
  await nextTurn()
  assert.deepEqual(opened, ['https://example.com/docs?q=1', 'http://localhost:3000'])
})

test('handles external opening rejection without an unhandled promise', async () => {
  let failures = 0
  const handler = createExternalLinkHandler(async () => { throw new Error('OS rejected the link') }, () => { failures++ })
  assert.deepEqual(handler({ url: 'https://example.com' }), { action: 'deny' })
  await nextTurn()
  assert.equal(failures, 1)
})
