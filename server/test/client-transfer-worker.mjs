// Run the actual Electron-main adapter in its native ESM/TypeScript runtime.
// The server remains in Jest; no client package imports server code.
import { ApiClient } from '../../client/src/main/api/api-client.ts'
import { FtpApi } from '../../client/src/main/api/ftp-api.ts'

const [apiUrl, ftpUrl, localPath, direction] = process.argv.slice(2)
const api = new FtpApi(new ApiClient(apiUrl))
const send = (event, error) => process.send?.({ event, code: error?.code, message: error?.message })

await api.connect(ftpUrl)
await api.login({ username: 'test', password: 'secret' })
process.on('message', (message) => {
  if (message === 'start') {
    const first = api[direction]({ transferId: 'worker-first', localPath, remotePath: '/first' })
    void first.then(() => send('first-unexpected-success'), async (error) => {
      send('first-settled', error)
      // Match the renderer: the next queued operation starts when the active
      // upload/download promise settles, not when cancelTransfer resolves.
      try {
        await api.upload({ transferId: 'worker-next', localPath, remotePath: '/tệp%20.txt ' })
        send('next-completed')
      } catch (failure) { send('next-failed', failure) }
    })
  } else if (message === 'cancel') {
    void api.cancelTransfer('worker-first').then(() => send('cancel-settled'), (error) => send('cancel-failed', error))
  } else if (message === 'close') {
    void api.disconnect().finally(() => process.disconnect())
  }
})
send('ready')
