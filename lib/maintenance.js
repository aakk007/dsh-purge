// 社区版维护机制的兼容接入层：内容寻址备份、互斥写入、完整校验后切换。
// 不执行宿主补丁、不重启宿主、不改提示词、权限和用户预设。
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicFiles } from './atomic-files.js';
import { acquireMaintenanceLock } from './maintenance-lock.js';
import { assertNoLinkedDescendants, within } from './path-boundary.js';
import { removeTreeNoFollowSync } from './remove-tree.js';

export const MANAGED_NAMES = Object.freeze([
  'lib', 'bin', 'docs', 'presets', 'skills', 'scripts', 'locale',
  'client.js', 'cordis.patch.yml', 'screenshots.json', 'package.json',
  'README.md', 'README.zh-CN.md', 'LICENSE', 'MIRROR-NOTICE.md',
  'release-notes.md', 'NOTICE.md', 'CONTRIBUTORS.md', 'icon.png',
]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const { atomicWriteSync } = atomicFiles(fs);
const isMissing = error => error?.code === 'ENOENT';
const MAX_BYTES = 256 * 1024 * 1024;

function diskPath(value) {
  const direct = globalThis[Symbol.for('dsh.go.direct')];
  return path.resolve(direct?.toHost ? direct.toHost(value) : value);
}
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function exists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (isMissing(error)) return false; throw error; }
}
function relativeFile(rel) {
  if (typeof rel !== 'string' || /[\\:\x00-\x1f]/.test(rel) ||
      rel.split('/').some(p => !p || p === '.' || p === '..') ||
      !MANAGED_NAMES.includes(rel.split('/')[0])) throw Error('备份路径无效');
  return rel;
}
function walkFiles(root, callback) {
  const visit = (file, rel) => {
    assertNoLinkedDescendants(root, file);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), `${rel}/${name}`);
    } else {
      // pnpm 安装文件可能是硬链接；只读复制不会修改共享存储中的原件。
      if (!stat.isFile()) throw Error(`不支持的文件类型：${rel}`);
      callback(file, relativeFile(rel), stat);
    }
  };
  for (const name of MANAGED_NAMES) if (exists(path.join(root, name))) visit(path.join(root, name), name);
}

export class MaintenanceStore {
  constructor({ home, root }) {
    this.root = fs.realpathSync(diskPath(root));
    this.base = path.join(diskPath(home), 'dsh-purge', 'maintenance');
    if (within(this.root, this.base) || within(this.base, this.root)) throw Error('备份目录必须位于插件目录之外');
    this.key = hash(this.root).slice(0, 20);
    this.snapshots = path.join(this.base, 'snapshots', this.key);
    this.objects = path.join(this.base, 'objects');
    assertNoLinkedDescendants(diskPath(home), this.base);
    fs.mkdirSync(this.snapshots, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.objects, { recursive: true, mode: 0o700 });
    this.lease = null;
  }
  locked(action) {
    if (this.lease) throw Error('不允许嵌套维护操作');
    const lease = acquireMaintenanceLock(this.base);
    this.lease = lease;
    try {
      const result = action();
      if (result?.then) throw Error('维护事务必须同步执行');
      lease.check();
      return result;
    } finally {
      this.lease = null;
      const warning = lease.release();
      if (warning) throw Object.assign(Error('维护锁释放失败；操作结果请重新读取'), { detail: warning });
    }
  }
  check() {
    if (!this.lease) throw Error('未持有维护锁');
    this.lease.check();
    assertNoLinkedDescendants(this.base, this.snapshots);
    assertNoLinkedDescendants(this.base, this.objects);
  }
  manifest(id) {
    if (typeof id !== 'string' || !/^[0-9]{13}-[a-f0-9-]{36}$/.test(id)) throw Error('备份编号无效');
    const file = path.join(this.snapshots, `${id}.json`);
    assertNoLinkedDescendants(this.base, file);
    const data = readJSON(file);
    if (data.schema !== 1 || data.id !== id || data.root !== this.root ||
        !Array.isArray(data.files) || !Array.isArray(data.present) ||
        data.present.some(n => !MANAGED_NAMES.includes(n)) ||
        new Set(data.present).size !== data.present.length) throw Error('备份清单无效');
    const seen = new Set();
    for (const item of data.files) {
      relativeFile(item.path);
      if (seen.has(item.path) || !data.present.includes(item.path.split('/')[0]) ||
          !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) ||
          item.size < 0 || !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777) throw Error('备份文件记录无效');
      seen.add(item.path);
    }
    return data;
  }
  list() {
    assertNoLinkedDescendants(this.base, this.snapshots);
    return fs.readdirSync(this.snapshots).filter(n => n.endsWith('.json')).sort().reverse().map(name => {
      const id = name.slice(0, -5);
      try {
        const m = this.manifest(id);
        return { id, version: m.version, reason: m.reason, at: m.at, files: m.files.length,
          bytes: m.files.reduce((total, f) => total + f.size, 0) };
      } catch (error) { return { id, error: error.message }; }
    });
  }
  snapshot(reason = 'manual') {
    return this.locked(() => this.capture(reason));
  }
  capture(reason) {
    this.check();
    const pkg = readJSON(path.join(this.root, 'package.json'));
    if (pkg.name !== 'dsh-purge') throw Error('插件包身份不匹配');
    const data = {
      schema: 1, id: `${Date.now()}-${randomUUID()}`, root: this.root,
      at: new Date().toISOString(), version: pkg.version,
      reason: String(reason).slice(0, 120), present: [], files: [],
    };
    let total = 0;
    for (const name of MANAGED_NAMES) if (exists(path.join(this.root, name))) data.present.push(name);
    walkFiles(this.root, (file, rel, stat) => {
      this.check();
      total += stat.size;
      if (total > MAX_BYTES) throw Error('插件备份超过 256 MiB');
      const bytes = fs.readFileSync(file);
      if (bytes.length !== stat.size) throw Error(`备份期间文件变化：${rel}`);
      const sha256 = hash(bytes), object = path.join(this.objects, sha256);
      assertNoLinkedDescendants(this.base, object);
      if (exists(object)) {
        if (hash(fs.readFileSync(object)) !== sha256) throw Error('已有备份对象损坏');
      } else atomicWriteSync(object, bytes, undefined, { exactMode: 0o600, durable: true });
      data.files.push({ path: rel, size: bytes.length, mode: stat.mode & 0o777, sha256 });
    });
    atomicWriteSync(path.join(this.snapshots, `${data.id}.json`), JSON.stringify(data, null, 2) + '\n',
      'utf8', { exactMode: 0o600, durable: true });
    return { id: data.id, version: data.version, files: data.files.length, bytes: total };
  }
  materialize(id, stage) {
    const manifest = this.manifest(id);
    for (const name of manifest.present) {
      // 空目录也需要恢复；顶层文件由文件记录创建。
      if (!manifest.files.some(f => f.path === name)) fs.mkdirSync(path.join(stage, name), { recursive: true });
    }
    let total = 0;
    for (const item of manifest.files) {
      total += item.size;
      if (total > MAX_BYTES) throw Error('备份超过大小限制');
      const object = path.join(this.objects, item.sha256);
      assertNoLinkedDescendants(this.base, object);
      const bytes = fs.readFileSync(object);
      if (bytes.length !== item.size || hash(bytes) !== item.sha256) throw Error(`备份内容校验失败：${item.path}`);
      const target = path.join(stage, item.path);
      assertNoLinkedDescendants(stage, target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: item.mode });
      fs.chmodSync(target, item.mode);
    }
    if (readJSON(path.join(stage, 'package.json')).name !== 'dsh-purge') throw Error('恢复包身份不匹配');
    return manifest;
  }
  replace(stage, { beforeRename = () => {} } = {}) {
    this.check();
    const previous = path.join(this.root, `.maintenance-previous-${randomUUID()}`);
    fs.mkdirSync(previous);
    const moved = [];
    try {
      // 全部目标先检查，任何链接都在写入前报错。
      walkFiles(this.root, () => {});
      walkFiles(stage, () => {});
      for (const name of MANAGED_NAMES) {
        this.check();
        const dest = path.join(this.root, name), source = path.join(stage, name);
        const item = { name, saved: false, installed: false };
        moved.push(item);
        if (exists(dest)) { fs.renameSync(dest, path.join(previous, name)); item.saved = true; }
        beforeRename(name);
        if (exists(source)) { fs.renameSync(source, dest); item.installed = true; }
      }
    } catch (error) {
      const recoveryErrors = [];
      for (const item of moved.reverse()) {
        try {
          this.check();
          const dest = path.join(this.root, item.name);
          if (item.installed) removeTreeNoFollowSync(dest);
          if (item.saved) fs.renameSync(path.join(previous, item.name), dest);
        } catch (failure) { recoveryErrors.push(failure); }
      }
      if (recoveryErrors.length) throw new AggregateError([error, ...recoveryErrors], `恢复未完成，原件保留于 ${previous}`);
      removeTreeNoFollowSync(previous);
      throw error;
    }
    try { removeTreeNoFollowSync(previous); }
    catch (error) { return { cleanupWarning: `旧文件清理失败，保留于 ${previous}：${error.message}` }; }
    return {};
  }
  assertInstalled() {
    if (exists(path.join(this.root, '.git'))) throw Error('源码工作区请使用 Git 回滚；未改动检出文件');
  }
  restore(id, options = {}) {
    return this.locked(() => {
      this.assertInstalled();
      const stage = path.join(this.root, `.maintenance-stage-${randomUUID()}`);
      fs.mkdirSync(stage);
      try {
        const manifest = this.materialize(id, stage);
        const backup = this.capture('before-rollback');
        const result = this.replace(stage, options);
        return { ok: true, restored: id, version: manifest.version, backup: backup.id, restartRequired: true, ...result };
      } finally { removeTreeNoFollowSync(stage); }
    });
  }
  installVerified(source, options = {}) {
    return this.locked(() => {
      this.assertInstalled();
      if (readJSON(path.join(source, 'package.json')).name !== 'dsh-purge') throw Error('更新包身份不匹配');
      const stage = path.join(this.root, `.maintenance-stage-${randomUUID()}`);
      fs.mkdirSync(stage);
      try {
        walkFiles(source, (file, rel, stat) => {
          const dest = path.join(stage, rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(file, dest);
          fs.chmodSync(dest, stat.mode & 0o777);
        });
        const backup = this.capture('before-update');
        const result = this.replace(stage, options);
        return { ok: true, backup: backup.id, restartRequired: true, ...result };
      } finally { removeTreeNoFollowSync(stage); }
    });
  }
  status() {
    return { ok: true, root: this.root, repository: 'aakk007/dsh-purge',
      version: readJSON(path.join(this.root, 'package.json')).version,
      backups: this.list(), sourceCheckout: exists(path.join(this.root, '.git')) };
  }
}
