export function createShutdownHandler(dispose: () => Promise<void>, quit: () => void): (event: { preventDefault(): void }) => void {
  let pending = false
  let complete = false
  return (event) => {
    if (complete) return
    event.preventDefault()
    if (pending) return
    pending = true
    void (async () => {
      try { await dispose() }
      catch { console.warn('Could not finish FTP client cleanup during shutdown') }
      finally { complete = true; quit() }
    })()
  }
}
