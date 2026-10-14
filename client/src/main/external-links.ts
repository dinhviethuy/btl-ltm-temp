type OpenExternal = (url: string) => Promise<void>

export function createExternalLinkHandler(openExternal: OpenExternal, onError: () => void = () => console.warn('Could not open external link')) {
  return ({ url }: { url: string }): { action: 'deny' } => {
    try {
      const protocol = new URL(url).protocol
      if (protocol === 'http:' || protocol === 'https:') {
        void Promise.resolve().then(() => openExternal(url)).catch(onError)
      }
    } catch { /* Ignore invalid URLs supplied to the window-open boundary. */ }
    return { action: 'deny' }
  }
}
