export const FTP_TIMEOUT = {
  connect: 10_000,
  command: 15_000,

  dataConnect: 10_000,
  dataIdle: 30_000,

  transfer: 5 * 60_000
} as const
