import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { LocalFileSystem } from '../src/local/local-file-system.ts'

test('rejects unsafe Windows download names before resolving or writing them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ftp-client-local-'))
  try {
    const local = new LocalFileSystem(root)
    const names = ['D:README.md', 'C:README.md', 'report.txt:secret', 'CON', 'con.txt', 'NUL.txt', 'PRN', 'AUX', 'COM1.log', 'LPT9', 'COM¹.txt', 'CONIN$', 'name.', 'name ', 'bad<name', 'bad|name', 'bad\u0000name', '..', '../escape', 'nested/../../escape']
    for (const name of names) {
      assert.throws(() => local.resolvePath(name), /không hợp lệ|không được chứa đường dẫn|ngoài thư mục/, name)
    }
    for (const name of ['D:README.md', 'report.txt:secret', 'CON', 'name.']) {
      await assert.rejects(local.mkdir(name), /không hợp lệ/, name)
    }
    assert.deepEqual(await local.lls(), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('contains download destinations in the selected directory and preserves valid names', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ftp-client-local-'))
  try {
    const local = new LocalFileSystem(root)
    for (const name of [' báo cáo %.txt', '資料 100%.txt', 'a b.txt']) {
      assert.equal(local.resolvePath(name), path.join(root, name))
    }
    await local.mkdir('tài liệu %')
    assert.equal(local.resolvePath(`${path.join(root, 'tài liệu %')}/ báo cáo %.txt`), path.join(root, 'tài liệu %', ' báo cáo %.txt'))
    assert.throws(() => local.resolvePath(path.join(root, '..', 'outside.txt')), /ngoài thư mục/)
    assert.throws(() => local.resolvePath(path.join(root, 'child', '..', '..', 'outside.txt')), /ngoài thư mục/)
    await local.mkdir(' thư mục %')
    assert.ok((await local.lls()).some((entry) => entry.name === ' thư mục %'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('lists files from the active local directory', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'ftp-client-local-'))
  try {
    await writeFile(path.join(tempDirectory, 'sample.txt'), 'sample')
    await mkdir(path.join(tempDirectory, 'documents'))
    const local = new LocalFileSystem(tempDirectory)

    assert.equal(local.lpwd(), path.resolve(tempDirectory))
    const files = await local.lls()
    assert.ok(files.some((file) => file.name === 'sample.txt' && file.type === 'file' && file.size === 6))
    assert.ok(files.some((file) => file.name === 'documents' && file.type === 'directory'))
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
})

test('changes directory and lists another path without changing the active directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ftp-client-local-'))
  try {
    await mkdir(path.join(root, 'documents'))
    await writeFile(path.join(root, 'documents', 'note.txt'), 'note')
    const local = new LocalFileSystem(root)

    assert.deepEqual((await local.lls('documents')).map((file) => file.name), ['note.txt'])
    assert.equal(local.lpwd(), root)
    await local.lcd('documents')
    assert.equal(local.lpwd(), path.join(root, 'documents'))
    assert.deepEqual((await local.lls()).map((file) => file.name), ['note.txt'])
    await local.lcd('..')
    assert.equal(local.lpwd(), root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects invalid directory changes without losing the active directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ftp-client-local-'))
  try {
    await writeFile(path.join(root, 'sample.txt'), 'sample')
    const local = new LocalFileSystem(root)

    await assert.rejects(local.lcd('missing'), /không tồn tại/)
    await assert.rejects(local.lcd('sample.txt'), /không phải thư mục/)
    assert.equal(local.lpwd(), root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('manages and moves local entries with overwrite protection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ftp-client-local-'))
  try {
    const local = new LocalFileSystem(root)
    await local.mkdir('temporary')
    await local.rename('temporary', 'renamed')
    assert.ok((await local.lls()).some((file) => file.name === 'renamed' && file.type === 'directory'))
    await local.deleteDirectory('renamed')

    await writeFile(path.join(root, 'sample.txt'), 'sample')
    await local.rename('sample.txt', 'renamed.txt')
    await local.deleteFile('renamed.txt')
    assert.ok(!(await local.lls()).some((file) => file.name === 'renamed.txt'))

    await local.mkdir('destination')
    await writeFile(path.join(root, 'move-me.txt'), 'new')
    await writeFile(path.join(root, 'destination', 'move-me.txt'), 'old')
    await assert.rejects(local.move('move-me.txt', 'destination'), /Đã tồn tại/)
    await local.move('move-me.txt', 'destination', true)
    assert.equal(await readFile(path.join(root, 'destination', 'move-me.txt'), 'utf8'), 'new')

    await writeFile(path.join(root, 'rename-on-move.txt'), 'renamed')
    await local.move('rename-on-move.txt', 'destination', false, 'renamed-on-move.txt')
    assert.equal(await readFile(path.join(root, 'destination', 'renamed-on-move.txt'), 'utf8'), 'renamed')
    await assert.rejects(local.mkdir('..'), /không được chứa đường dẫn/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
