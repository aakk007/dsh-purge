// 采用社区版 preset-migrations 的内容寻址及先备份后注册约定。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertNoLinkedDescendants } from '../path-boundary.js';
import { removeTreeNoFollowSync } from '../remove-tree.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function backupPresetMigration({ home, dir, id, definitions }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw Error('预设编号无效');
  const direct = globalThis[Symbol.for('dsh.go.direct')];
  home = path.resolve(direct?.toHost ? direct.toHost(home) : home);
  dir = path.resolve(direct?.toHost ? direct.toHost(dir) : dir);
  const files = [];
  for (const name of ['agent.cordis.yml', 'preset.yml']) {
    const file = path.join(dir, name);
    assertNoLinkedDescendants(dir, file);
    try {
      if (!fs.lstatSync(file).isFile()) throw Error('预设源文件类型无效');
      files.push({ name, bytes: fs.readFileSync(file) });
    } catch (error) {
      if (error.code !== 'ENOENT' || name === 'agent.cordis.yml') throw error;
    }
  }
  const digest = hash(Buffer.concat(files.flatMap(f => [Buffer.from(f.name + '\0'), f.bytes])));
  const base = path.join(home, 'dsh-purge', 'preset-migrations');
  const target = path.join(base, `${id}-${digest}`);
  assertNoLinkedDescendants(home, target);
  const validate = () => {
    for (const file of files) {
      assertNoLinkedDescendants(base, path.join(target, file.name));
      if (!fs.readFileSync(path.join(target, file.name)).equals(file.bytes)) throw Error('迁移备份内容损坏');
    }
    assertNoLinkedDescendants(base, path.join(target, 'manifest.json'));
    const m = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
    if (m.digest !== digest || m.id !== id || m.sourceUnchanged !== true) throw Error('迁移备份清单损坏');
  };
  if (fs.existsSync(target)) { validate(); return target; }
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(base, '.staging-'));
  try {
    for (const file of files) fs.writeFileSync(path.join(stage, file.name), file.bytes, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({
      schema: 1, id, digest, created: new Date().toISOString(), sourceUnchanged: true,
      registeredPresets: definitions.map(def => def.id),
      files: files.map(f => ({ name: f.name, sha256: hash(f.bytes) })),
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try { fs.renameSync(stage, target); }
    catch (error) { if (!fs.existsSync(target)) throw error; }
    validate();
    return target;
  } finally { removeTreeNoFollowSync(stage); }
}
