import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createShutdownHandler } from '../src/main/shutdown.ts'
import { deferred } from './deferred.ts'

test('normal shutdown waits for local cleanup once before allowing the final quit event', async () => {
  const cleaned = deferred<void>()
  const quit = deferred<void>()
  let disposals = 0
  let prevented = 0
  const beforeQuit = createShutdownHandler(async () => { disposals++; await cleaned.promise }, () => quit.resolve())
  const event = { preventDefault() { prevented++ } }
  beforeQuit(event)
  beforeQuit(event)
  assert.equal(prevented, 2)
  assert.equal(disposals, 1)
  cleaned.resolve()
  await quit.promise
  beforeQuit(event)
  assert.equal(prevented, 2)
})

test('shutdown still exits after cleanup fails and logs only a safe diagnostic', async (t) => {
  let warning = ''
  t.mock.method(console, 'warn', (message: string) => { warning = message })
  const quit = deferred<void>()
  const beforeQuit = createShutdownHandler(async () => { throw new Error('private remote path') }, () => quit.resolve())
  beforeQuit({ preventDefault() {} })
  await quit.promise
  assert.ok(warning)
  assert.doesNotMatch(warning, /private remote path/)
})
