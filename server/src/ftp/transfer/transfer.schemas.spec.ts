import { uploadHeaders } from './transfer.schemas'

describe('upload streaming headers', () => {
  const valid = { 'content-type': 'application/octet-stream', 'x-transfer-id': 'transfer-1', 'x-remote-path-encoded': '%2F%20report%20' }

  it.each(['-1', '1.5', '1e3', '9007199254740992', ''])('rejects invalid content-length %s with 422', (length) => {
    expect(() => uploadHeaders({ ...valid, 'content-length': length })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR', status: 422 }))
  })

  it.each([
    ['%2Ft%E1%BB%87p.txt', '/tệp.txt'], ['%20%2Freport%20', ' /report '],
    ['%2Fliteral%2520%252F.txt', '/literal%20%2F.txt'],
  ])('decodes the encoded path %s exactly once without trimming it', (encoded, path) => {
    expect(uploadHeaders({ ...valid, 'x-remote-path-encoded': encoded }).remotePath).toBe(path)
  })

  it.each(['%', '%ZZ', '%C3%28', '%2Ffile%0D%0ANOOP', '/raw', ' /trimmed ', 'tệp.txt'])('rejects malformed or unsafe encoded path %s', (encoded) => {
    expect(() => uploadHeaders({ ...valid, 'x-remote-path-encoded': encoded }))
      .toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR', status: 422 }))
  })

  it('rejects the ambiguous legacy header even when an encoded header is also present', () => {
    expect(() => uploadHeaders({ ...valid, 'x-remote-path': '/different' }))
      .toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR', status: 422 }))
  })

  it('preserves paths and distinguishes zero-byte from unknown-size uploads', () => {
    expect(uploadHeaders(valid)).toEqual({ transferId: 'transfer-1', remotePath: '/ report ', totalBytes: undefined })
    expect(uploadHeaders({ ...valid, 'content-length': '0' }).totalBytes).toBe(0)
  })
})
