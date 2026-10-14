import { LoginSchema } from './session.schemas'

describe('LoginSchema command boundaries', () => {
  it.each(['\r', '\n', '\r\nDELE /victim'])('rejects line breaks %j before trimming username or accepting password', (suffix) => {
    expect(LoginSchema.safeParse({ username: `demo${suffix}`, password: 'secret' }).success).toBe(false)
    expect(LoginSchema.safeParse({ username: 'demo', password: `secret${suffix}` }).success).toBe(false)
  })

  it('preserves password spaces and Unicode while retaining username trimming', () => {
    expect(LoginSchema.parse({ username: '  người dùng  ', password: ' mật khẩu % ' })).toEqual({ username: 'người dùng', password: ' mật khẩu % ' })
    expect(LoginSchema.parse({ username: 'anonymous', password: '' }).password).toBe('')
  })
})
