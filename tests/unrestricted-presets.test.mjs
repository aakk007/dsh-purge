import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPresetDefinition } from '../lib/redteam/preset-composition.js';
import {
  UNRESTRICTED_PRESET_ID, UNRESTRICTED_WORKER, installPreset, presetSourceDir,
  registerUnrestrictedPresets, userPresetDir,
} from '../lib/presets/index.js';

const bundledDir = fileURLToPath(new URL('../presets/unrestricted', import.meta.url));
const flatten = rows => rows.flatMap(row => (row.group ? flatten(row.config) : [row]));
const tempHome = () => mkdtempSync(join(tmpdir(), 'dsh-purge-presets-'));

test('无限制模式预设：随包骨架可解析，id/名称/排序符合模式下拉约定', () => {
  const definition = readPresetDefinition(UNRESTRICTED_PRESET_ID, bundledDir);
  assert.equal(definition.id, 'unrestricted');
  assert.equal(definition.name, '无限制模式');
  assert.equal(definition.order, 20);
  const ids = flatten(definition.plugins).map(row => row.id);
  for (const id of ['persona', 'tool-subagent', 'tool-skill', 'tool-fs', 'tool-bash']) {
    assert.ok(ids.includes(id), `缺少工具行 ${id}`);
  }
  // 演练台的行不该出现在无限制模式里。
  for (const id of ['redteam-tools', 'anchor-gate']) assert.equal(ids.includes(id), false, `${id} 不应随无限制模式出现`);
});

test('落地：已有用户文件不覆盖，force 才重写', () => {
  const home = tempHome();
  const first = installPreset({ home });
  assert.equal(first.action, 'installed');
  const file = join(userPresetDir(home), 'agent.cordis.yml');
  writeFileSync(file, '# 用户自己改过\n- id: persona\n  name: ./mine.mjs\n', 'utf8');
  const before = readFileSync(file, 'utf8');
  const kept = installPreset({ home });
  assert.equal(kept.action, 'kept');
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(presetSourceDir(home), userPresetDir(home));
  const forced = installPreset({ home, force: true });
  assert.equal(forced.action, 'updated');
  assert.notEqual(readFileSync(file, 'utf8'), before);
  assert.match(readFileSync(file, 'utf8'), /你在「无限制模式」下工作/);
});

test('注册：无限制模式 + 无限制模式（子智能体），子预设无后续委派入口', async t => {
  const home = tempHome();
  installPreset({ home });
  const userFile = join(userPresetDir(home), 'agent.cordis.yml');
  const original = readFileSync(userFile);
  const calls = [];
  const registry = {
    async register(definition) {
      calls.push(['add', definition.id, definition.name]);
      return async () => { calls.push(['remove', definition.id]); };
    },
    async list() { return []; },
  };
  const result = await registerUnrestrictedPresets(registry, { home, hostCompat: { state: 'not-dsh-go' } });
  t.after(async () => { await result.release(); });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ids, [UNRESTRICTED_WORKER.workerId, UNRESTRICTED_PRESET_ID]);
  assert.deepEqual(calls, [
    ['add', 'unrestricted-worker', '无限制模式（子智能体）'],
    ['add', 'unrestricted', '无限制模式'],
  ]);
  // 用户磁盘上的预设不被注册过程改写。
  assert.deepEqual(readFileSync(userFile), original);

  const [worker, commander] = result.definitions;
  const parentRows = flatten(commander.plugins);
  const childRows = flatten(worker.plugins);
  const spawn = parentRows.find(row => row.id === 'tool-subagent');
  assert.equal(spawn.config.toolFilter, undefined);
  assert.equal(spawn.config.modelSelectionSettings, undefined);
  assert.equal(spawn.config.modelSelection, true);
  assert.equal(spawn.config.modelDiscovery, true);
  assert.equal(spawn.config.agentPreset, 'unrestricted-worker');
  assert.equal(spawn.config.maxDepth, 1);
  assert.equal(childRows.some(row => row.name === '@deepseek-ai/dsh-tool-subagent' ||
    ['tool-workflow', 'tool-ralph', 'workflow-ptc'].includes(row.id)), false);
  assert.equal(childRows.find(row => row.id === 'persona').config.prefix,
    parentRows.find(row => row.id === 'persona').config.prefix);

  // 迁移前备份与注册状态分开落盘，便于排错。
  const status = JSON.parse(readFileSync(join(home, 'dsh-purge', 'unrestricted-preset.json'), 'utf8'));
  assert.equal(status.ok, true);
  assert.deepEqual(status.registeredPresets, ['unrestricted-worker', 'unrestricted']);
  const backupRoot = join(home, 'dsh-purge', 'preset-migrations');
  assert.ok(existsSync(backupRoot), '注册迁移应留下内容寻址备份');
});

test('自定义旧委派配置：明确失败，不静默放宽', async () => {
  const definition = readPresetDefinition(UNRESTRICTED_PRESET_ID, bundledDir);
  flatten(definition.plugins).find(row => row.id === 'tool-subagent').config.toolFilter.deny.push('bash');
  const before = structuredClone(definition);
  const { prepareSubagentPresets } = await import('../lib/host-compat/subagent-presets.mjs');
  assert.throws(
    () => prepareSubagentPresets(definition, UNRESTRICTED_WORKER),
    /无限制模式预设 .*无法无损自动迁移/,
  );
  assert.deepEqual(definition, before);
});
