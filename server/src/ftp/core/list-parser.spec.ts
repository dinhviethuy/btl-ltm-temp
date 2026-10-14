import { parseList, parseListLine } from './list-parser'

describe('LIST parser', () => {
  it('parses files, directories, and names with spaces', () => {
    expect(parseListLine('-rw-rw-rw- 1 ftp ftp 7 Aug 20 01:25 hello.txt')).toEqual({
      name: 'hello.txt', type: 'file', size: 7, permissions: '-rw-rw-rw-', owner: 'ftp', group: 'ftp', modified: 'Aug 20 01:25', raw: '-rw-rw-rw- 1 ftp ftp 7 Aug 20 01:25 hello.txt'
    })
    expect(parseListLine('drwxrwxrwx 1 ftp ftp 0 Aug 20 01:26 images')?.type).toBe('directory')
    expect(parseListLine('-rw-rw-rw- 1 ftp ftp 8 Aug 20 01:25 file with spaces.txt')?.name).toBe('file with spaces.txt')
  })

  it('ignores blank and unsupported lines', () => {
    expect(parseList('-rw-rw-rw- 1 ftp ftp 7 Aug 20 01:25 hello.txt\r\n\r\n')).toHaveLength(1)
    expect(parseListLine('this is not an FTP LIST line')).toBeNull()
  })

  it('parses several LIST rows in order', () => {
    const listing = [
      '-rw-rw-rw- 1 ftp ftp 7 Aug 20 01:25 hello.txt',
      'drwxrwxrwx 1 ftp ftp 0 Aug 20 01:26 images',
      '-rw-rw-rw- 1 ftp ftp 8 Aug 20 01:25 test.txt'
    ].join('\r\n')
    expect(parseList(listing).map((file) => file.name)).toEqual(['hello.txt', 'images', 'test.txt'])
  })
})
