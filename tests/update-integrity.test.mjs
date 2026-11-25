import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sourceManifest, verifySourceTree } from '../lib/update-integrity.js';
import { overlayFromZip, REPO } from '../lib/update.js';

const sha = 'a'.repeat(40), treeSha = 'b'.repeat(40);
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const files = {
  'package.json': Buffer.from('{"name":"dsh-purge","version":"2.0.0"}'),
  'lib/keep.js': Buffer.from('new version'),
};
const entries = () => Object.entries(files).map(([path, bytes]) => ({ path, sha: blob(bytes), mode: '100644', type: 'blob' }));
const manifest = () => ({ sha, files: new Map(entries().map(item => [item.path, item])) });
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-update-integrity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function writeTree(dir) {
  for (const [name, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), bytes);
  }
}
// 生成无压缩标准 ZIP；测试实际走现有解压器，不执行下载内容。
function archive() {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, bytes] of Object.entries(files)) {
    const filename = Buffer.from('plugin/' + name);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(bytes.length, 20);
    header.writeUInt32LE(bytes.length, 24); header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(offset, 42);
    parts.push(local, filename, bytes); central.push(header, filename);
    offset += local.length + filename.length + bytes.length;
  }
  const end = Buffer.alloc(22), directory = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

test('source metadata pins commit and uses only configured fork', async () => {
  const urls = [];
  const result = await sourceManifest('master', { json: async url => {
    urls.push(url);
    return url.includes('/commits/') ? { sha, commit: { tree: { sha: treeSha } } } : { sha: treeSha, tree: entries() };
  } });
  assert.equal(REPO, 'aakk007/dsh-purge');
  assert.equal(result.sha, sha);
  assert(urls.every(url => url.startsWith('https://api.github.com/repos/aakk007/dsh-purge/')));
});
test('truncated, wrong commit and traversal metadata fail before installation', async () => {
  await assert.rejects(sourceManifest('c'.repeat(40), { json: async () => ({ sha, commit: { tree: { sha: treeSha } } }) }), /不匹配/);
  for (const payload of [
    { sha: treeSha, truncated: true, tree: entries() },
    { sha: treeSha, tree: [...entries(), { path: '../escape', sha, mode: '100644', type: 'blob' }] },
  ]) {
    await assert.rejects(sourceManifest('master', { json: async url => url.includes('/commits/')
      ? { sha, commit: { tree: { sha: treeSha } } } : payload }));
  }
});
test('tree verification rejects altered, additional and missing files', t => {
  const root = temp(t); writeTree(root);
  assert.equal(verifySourceTree(root, manifest()).verifiedFiles, 2);
  fs.writeFileSync(path.join(root, 'extra'), 'extra');
  assert.throws(() => verifySourceTree(root, manifest()), /未登记文件/);
  fs.unlinkSync(path.join(root, 'extra'));
  fs.writeFileSync(path.join(root, 'lib/keep.js'), 'tampered');
  assert.throws(() => verifySourceTree(root, manifest()), /完整性校验失败/);
  fs.unlinkSync(path.join(root, 'lib/keep.js'));
  assert.throws(() => verifySourceTree(root, manifest()), /缺失文件/);
});
test('real ZIP overlay is pinned, creates backup and preserves unrelated files', async t => {
  const dir = temp(t), root = path.join(dir, 'plugin'), home = path.join(dir, 'home');
  writeTree(root);
  fs.writeFileSync(path.join(root, 'lib/keep.js'), 'previous');
  fs.writeFileSync(path.join(root, 'personal.txt'), 'keep');
  let url;
  const result = await overlayFromZip([root], 'master', {
    home, manifest: manifest(), fetchArchive: async value => { url = value; return { arrayBuffer: async () => archive() }; },
  });
  assert(url.includes(sha));
  assert.equal(result.sha, sha);
  assert.equal(result.backups.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'lib/keep.js'), 'utf8'), 'new version');
  assert.equal(fs.readFileSync(path.join(root, 'personal.txt'), 'utf8'), 'keep');
});
test('failure in second installation rolls first installation back', async t => {
  const dir = temp(t), first = path.join(dir, 'first'), second = path.join(dir, 'second');
  writeTree(first); writeTree(second);
  fs.writeFileSync(path.join(first, 'lib/keep.js'), 'original-first');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(second, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(overlayFromZip([first, second], 'master', {
    home: path.join(dir, 'home'), manifest: manifest(), fetchArchive: async () => ({ arrayBuffer: async () => archive() }),
  }), /symbolic link/);
  assert.equal(fs.readFileSync(path.join(first, 'lib/keep.js'), 'utf8'), 'original-first');
  assert.equal(fs.readFileSync(path.join(second, 'lib/keep.js'), 'utf8'), 'new version');
});
