// Bound the caller as well as the transport: an injected/unresponsive fetch
// implementation may ignore AbortSignal. Promise.race still observes any late
// rejection, while operation-specific observers can clean up late resources.
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>, milliseconds: number, timeout: Error,
  controller = new AbortController()
): Promise<T> {
  const timer = setTimeout(() => controller.abort(timeout), milliseconds)
  let abort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', abort, { once: true })
    if (controller.signal.aborted) abort()
  })
  try { return await Promise.race([operation(controller.signal), aborted]) }
  finally {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', abort)
  }
}
