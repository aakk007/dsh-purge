import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MaintenanceStore } from '../lib/maintenance.js';
import { maintenanceOperation } from '../lib/maintenance-api.js';
import { acquireMaintenanceLock } from '../lib/maintenance-lock.js';
import { atomicFiles } from '../lib/atomic-files.js';

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-maint-中文-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'plugin'), home = path.join(temp, 'home');
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"dsh-purge","version":"1.0.0"}');
  fs.writeFileSync(path.join(root, 'lib', 'keep.js'), 'original');
  fs.writeFileSync(path.join(root, 'user-extra.txt'), 'untouched');
  fs.writeFileSync(path.join(home, 'prompt-inject.md'), 'user prompt');
  const store = new MaintenanceStore({ root, home });
  return { temp, root, home, store };
}
const content = f => fs.readFileSync(path.join(f.root, 'lib/keep.js'), 'utf8');

test('snapshot deduplicates contents; rollback retains user data and creates recovery point', t => {
  const f = fixture(t), first = f.store.snapshot();
  const objects = fs.readdirSync(f.store.objects).length;
  f.store.snapshot();
  assert.equal(fs.readdirSync(f.store.objects).length, objects);
  fs.writeFileSync(path.join(f.root, 'lib/keep.js'), 'updated');
  fs.writeFileSync(path.join(f.root, 'lib/new.js'), 'new');
  const restored = f.store.restore(first.id);
  assert.equal(content(f), 'original');
  assert.equal(fs.existsSync(path.join(f.root, 'lib/new.js')), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'user-extra.txt'), 'utf8'), 'untouched');
  assert.equal(fs.readFileSync(path.join(f.home, 'prompt-inject.md'), 'utf8'), 'user prompt');
  assert.equal(restored.restartRequired, true);
  f.store.restore(restored.backup);
  assert.equal(content(f), 'updated');
  assert.equal(fs.readFileSync(path.join(f.root, 'lib/new.js'), 'utf8'), 'new');
});

test('corrupt backup is rejected before installed files change', t => {
  const f = fixture(t), backup = f.store.snapshot();
  const file = f.store.manifest(backup.id).files.find(item => item.path === 'lib/keep.js');
  fs.writeFileSync(path.join(f.store.objects, file.sha256), 'corrupt');
  assert.throws(() => f.store.restore(backup.id), /校验失败/);
  assert.equal(content(f), 'original');
});

test('interrupted rename restores every installed entry', t => {
  const f = fixture(t), backup = f.store.snapshot();
  fs.writeFileSync(path.join(f.root, 'lib/keep.js'), 'keep-new');
  assert.throws(() => f.store.restore(backup.id, {
    beforeRename(name) { if (name === 'package.json') throw Error('simulated EBUSY'); },
  }), /simulated EBUSY/);
  assert.equal(content(f), 'keep-new');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, '1.0.0');
  assert(!fs.readdirSync(f.root).some(name => name.startsWith('.maintenance-')));
});

test('live lock blocks concurrent writes and can be reacquired after release', t => {
  const f = fixture(t), lock = acquireMaintenanceLock(f.store.base);
  try { assert.throws(() => f.store.snapshot(), /已有维护操作/); }
  finally { assert.equal(lock.release(), null); }
  assert.ok(f.store.snapshot().id);
});

test('dead legacy lock is recovered but a stale live lock is preserved', t => {
  const f = fixture(t), file = path.join(f.store.base, 'maintenance.lock');
  fs.writeFileSync(file, '4194304');
  const lock = acquireMaintenanceLock(f.store.base, {
    kill() { throw Object.assign(Error('dead'), { code: 'ESRCH' }); },
  });
  lock.check(); lock.release();
  fs.writeFileSync(file, String(process.pid));
  const stale = new Date(Date.now() - 45 * 60 * 1000);
  fs.utimesSync(file, stale, stale);
  assert.throws(() => acquireMaintenanceLock(f.store.base, {
    kill() {}, birth: () => Date.now() - 60 * 60 * 1000,
  }), /已有维护操作/);
});

test('path traversal and a foreign snapshot are rejected', t => {
  const f = fixture(t), backup = f.store.snapshot();
  assert.throws(() => f.store.restore('../package.json'), /编号无效/);
  const manifestFile = path.join(f.store.snapshots, backup.id + '.json');
  const manifest = f.store.manifest(backup.id);
  manifest.files[0].path = '../outside';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => f.store.restore(backup.id), /路径无效/);
  assert.equal(content(f), 'original');
});

test('junction in plugin blocks backup and update; external content stays unchanged', t => {
  const f = fixture(t), external = path.join(f.temp, 'external');
  fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'secret'), 'keep');
  fs.symlinkSync(external, path.join(f.root, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.store.snapshot(), /symbolic link/);
  assert.equal(fs.readFileSync(path.join(external, 'secret'), 'utf8'), 'keep');
});

test('pnpm-style hardlinked files are copied without modifying shared originals', t => {
  const f = fixture(t), shared = path.join(f.temp, 'shared.js');
  fs.writeFileSync(shared, 'shared');
  fs.linkSync(shared, path.join(f.root, 'lib/shared.js'));
  const backup = f.store.snapshot();
  f.store.restore(backup.id);
  assert.equal(fs.readFileSync(shared, 'utf8'), 'shared');
});

test('source checkout is backed up but never overwritten by rollback or installer', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, '.git'), 'gitdir: example');
  const backup = f.store.snapshot();
  assert.throws(() => f.store.restore(backup.id), /源码工作区/);
  assert.throws(() => f.store.installVerified(f.root), /源码工作区/);
  assert.equal(content(f), 'original');
});

test('Direct runtime maps plugin and backup paths through host adapter', t => {
  const f = fixture(t), symbol = Symbol.for('dsh.go.direct'), prior = globalThis[symbol], calls = [];
  globalThis[symbol] = { toHost(value) {
    calls.push(value);
    return value === '/opt/plugin' ? f.root : value === '/home/dsh' ? f.home : value;
  } };
  try {
    const store = new MaintenanceStore({ root: '/opt/plugin', home: '/home/dsh' });
    assert.equal(store.root, fs.realpathSync(f.root));
    assert.ok(store.snapshot().id);
    assert.ok(calls.includes('/opt/plugin') && calls.includes('/home/dsh'));
  } finally { if (prior === undefined) delete globalThis[symbol]; else globalThis[symbol] = prior; }
});

test('HTTP operation cannot select arbitrary root and rejects unknown operations', t => {
  const f = fixture(t), context = { home: f.home, root: f.root };
  assert.throws(() => maintenanceOperation(context, { op: 'delete' }), /未知维护操作/);
  const result = maintenanceOperation(context, { op: 'backup', root: 'C:\\', home: '/' });
  assert.equal(result.ok, true);
  assert.equal(maintenanceOperation(context).backups.length, 1);
});

test('atomic writer preserves original data on rename failure and cleans temporary file', t => {
  const f = fixture(t), target = path.join(f.home, 'settings.json');
  fs.writeFileSync(target, 'old');
  const writers = atomicFiles({ ...fs, renameSync() { throw Object.assign(Error('denied'), { code: 'EROFS' }); } });
  assert.throws(() => writers.atomicWriteSync(target, 'new'), /denied/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old');
  assert(!fs.readdirSync(f.home).some(name => name.endsWith('.tmp')));
});
