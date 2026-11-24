import {
  existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageName = '@deepseek-ai/dsh-tool-subagent-control';
const version = '0.2.2-rc.1';
const shimName = 'lib/dsh-go-list-agents-compat.mjs';
const before = '95d1fda27613fedecf67e96b8c73f58d47f5ea376a06991870addac92d1a8792';
const after = 'b4b5833f74b8219d76623cb2784e4f505aaaf8000fc489e80c7a17470ff95b77';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function atomicWrite(file, bytes, mode) {
  const temporary = `${file}.dsh-go-${process.pid}.tmp`;
  writeFileSync(temporary, bytes, { flag: 'wx', mode });
  try {
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** 修复宿主导出，保留旧预设；只接受经验证的官方包字节。 */
export function installCompat(prefix, { check = false, restore = false } = {}) {
  const directory = realpathSync(join(resolve(prefix), 'node_modules', packageName));
  const manifest = join(directory, 'package.json');
  const shim = join(directory, shimName);
  const backup = `${manifest}.dsh-go-list-agents-original`;
  const bytes = readFileSync(manifest);
  const metadata = JSON.parse(bytes.toString('utf8'));
  if (metadata.name !== packageName || metadata.version !== version) {
    throw new Error(`需要 ${packageName}@${version}，实际为 ${metadata.name}@${metadata.version}`);
  }
  const current = hash(bytes);
  if (current !== before && current !== after) throw new Error('宿主清单摘要不匹配，未写入');
  const source = readFileSync(new URL('./list-agents-compat.mjs', import.meta.url));
  if (existsSync(shim) && !readFileSync(shim).equals(source)) {
    throw new Error('兼容入口已有其他内容，未覆盖');
  }
  if (existsSync(backup) && hash(readFileSync(backup)) !== before) {
    throw new Error('原始清单备份摘要不匹配，未覆盖');
  }
  const installed = current === after && existsSync(shim);
  if (check) return { state: installed ? 'installed' : 'needs-update', directory, backup };
  const mode = statSync(manifest).mode & 0o777;
  if (restore) {
    if (current === after) {
      if (!existsSync(backup)) throw new Error('没有原始清单备份，无法自动回滚');
      atomicWrite(manifest, readFileSync(backup), mode);
    }
    if (existsSync(shim)) unlinkSync(shim);
    return { state: 'restored', directory, backup, restartRequired: current === after };
  }
  if (installed) return { state: 'unchanged', directory, backup, restartRequired: false };
  if (current === before) {
    const { '.': main, ...otherExports } = metadata.exports;
    metadata.exports = { '.': main, './list-agents': `./${shimName}`, ...otherExports };
    metadata.files.splice(metadata.files.indexOf('lib/index.js') + 1, 0, shimName);
    const patched = Buffer.from(JSON.stringify(metadata, null, 2));
    if (hash(patched) !== after) throw new Error('生成结果与构建补丁摘要不同，未写入');
    if (!existsSync(backup)) writeFileSync(backup, bytes, { flag: 'wx', mode });
    // 先落地入口，再发布导出；主插件实现和用户预设均不写入。
    atomicWrite(shim, source, 0o644);
    atomicWrite(manifest, patched, mode);
  } else {
    atomicWrite(shim, source, 0o644);
  }
  return { state: 'installed', directory, backup, restartRequired: true };
}

/** Android DSH Go 的固定运行时；不搜索或改写其他宿主安装。 */
export function ensureDshGoCompat({
  mode = 'install', prefix = '/opt/dsh',
  marker = '/opt/dsh-go/dsh-go-bridge/package.json', platform = process.platform,
} = {}) {
  if (mode === 'off') return { state: 'disabled' };
  if (!['install', 'restore'].includes(mode)) throw new Error('hostCompat 必须是 install、restore 或 off');
  if (platform !== 'linux' || !existsSync(marker)) return { state: 'not-dsh-go' };
  const metadata = JSON.parse(readFileSync(join(prefix, 'node_modules', packageName, 'package.json'), 'utf8'));
  if (metadata.version !== version) return { state: 'unsupported-version', version: metadata.version };
  return installCompat(prefix, { restore: mode === 'restore' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const at = args.indexOf('--prefix');
    if (at < 0 || !args[at + 1] || args[at + 1].startsWith('--')) {
      throw new Error('用法：node subagent-list-agents.mjs --prefix /opt/dsh [--check | --restore]');
    }
    const flags = args.filter((_, index) => index !== at && index !== at + 1);
    if (flags.some(flag => !['--check', '--restore'].includes(flag)) ||
        (flags.includes('--check') && flags.includes('--restore'))) throw new Error('参数无效');
    console.log(JSON.stringify(installCompat(args[at + 1], {
      check: flags.includes('--check'), restore: flags.includes('--restore'),
    }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
