import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicFiles } from './atomic-files.js';
import { assertNoLinkedDescendants } from './path-boundary.js';

const { atomicWriteSync } = atomicFiles(fs);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// 安装来源迁移只修改本包的依赖值；先保存原始字节，锁文件由包管理器维护。
export function migrateProfileSource({ profile, home, url }) {
  if (!/^https:\/\/codeload\.github\.com\/aakk007\/dsh-purge\/tar\.gz\/[a-f0-9]{40}$/.test(url)) {
    throw Error('安装来源必须固定到本仓库完整提交');
  }
  const direct = globalThis[Symbol.for('dsh.go.direct')];
  profile = path.resolve(direct?.toHost ? direct.toHost(profile) : profile);
  home = path.resolve(direct?.toHost ? direct.toHost(home) : home);
  const file = path.join(profile, 'package.json');
  assertNoLinkedDescendants(profile, file);
  const bytes = fs.readFileSync(file), pkg = JSON.parse(bytes.toString('utf8'));
  let changed = false;
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (pkg[key] && Object.hasOwn(pkg[key], 'dsh-purge') && pkg[key]['dsh-purge'] !== url) {
      pkg[key]['dsh-purge'] = url;
      changed = true;
    }
  }
  if (!changed) return { changed: false };
  const base = path.join(home, 'dsh-purge', 'profile-migrations', hash(profile));
  const backup = path.join(base, `${hash(bytes)}.json`);
  assertNoLinkedDescendants(home, backup);
  if (fs.existsSync(backup)) {
    if (!fs.readFileSync(backup).equals(bytes)) throw Error('配置迁移备份损坏，未修改配置');
  } else {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    // 不覆盖已有备份；并发创建时验证内容。
    try { fs.writeFileSync(backup, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST' || !fs.readFileSync(backup).equals(bytes)) throw error; }
  }
  if (!fs.readFileSync(file).equals(bytes)) throw Error('配置被并发修改，原件和备份保留');
  atomicWriteSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8', { durable: true });
  return { changed: true, backup };
}
