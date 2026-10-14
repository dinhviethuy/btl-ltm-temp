const { FtpClient } = require('../src/ftp/core/ftp-client')
const { setImmediate: nextTurn } = require('node:timers/promises')

// Observe real process events outside Jest's replacement process object.
const unhandled = []
process.on('unhandledRejection', (error) => unhandled.push(error.code ?? error.message))

async function main() {
  const client = new FtpClient()
  try {
    await client.connect(process.argv[2])
    await client.login({ username: 'demo', password: 'secret' })
    let failed = false
    try { await client.list('/') } catch { failed = true }
    await nextTurn()
    process.send?.({ failed, unhandled, state: client.getState() })
  } finally {
    client.disconnect()
    process.disconnect()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
