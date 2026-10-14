import { fork } from 'node:child_process'
import { join } from 'node:path'
import { startTransferServer } from './ftp-test-server'

it('observes LIST data rejection immediately without a process unhandledRejection before the final reply', async () => {
  const server = await startTransferServer({ dropDataBeforeReply: true })
  const worker = fork(join(__dirname, 'list-reset-worker.cjs'), [`ftp://127.0.0.1:${server.port}`], {
    cwd: join(__dirname, '..'),
    execArgv: ['-r', require.resolve('ts-node/register/transpile-only')],
    env: { ...process.env, TS_NODE_PROJECT: join(__dirname, '../tsconfig.json') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  let errors = ''
  worker.stderr!.on('data', (chunk) => { errors += chunk.toString() })
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('exit', (code) => reject(new Error(`LIST worker exited (${code}): ${errors}`)))
      worker.once('error', reject)
    })
    expect(result).toEqual({ failed: true, unhandled: [], state: 'disconnected' })
  } finally { worker.kill(); await server.close() }
}, 10_000)
