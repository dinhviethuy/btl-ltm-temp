import type { FtpDesktopApi, LocalDesktopApi } from './shared/desktop-api'

declare global {
  interface Window {
    desktop: {
      platform: NodeJS.Platform
      bridgeVersion: number
    }
    ftp: FtpDesktopApi
    local: LocalDesktopApi
  }
}

export {}
