import test from 'node:test';
import assert from 'node:assert/strict';
import { readPresetDefinition } from '../lib/redteam/preset-composition.js';
import { prepareSubagentPresets, registerPresetDefinitions } from '../lib/host-compat/subagent-presets.mjs';
import { isRedteamPresetId } from '../lib/identity.js';
import { fileURLToPath } from 'node:url';

const readOriginal = () => readPresetDefinition('redteam',
  fileURLToPath(new URL('../presets/redteam', import.meta.url)));
const flatten = rows => rows.flatMap(row => row.group ? flatten(row.config) : [row]);

test('迁移原预设：执行预设无委派入口，原文件与其他配置保留', () => {
  const original = readOriginal();
  const before = structuredClone(original);
  const [worker, commander] = prepareSubagentPresets(original);
  assert.deepEqual(original, before);
  const parentRows = flatten(commander.plugins);
  const childRows = flatten(worker.plugins);
  const spawn = parentRows.find(row => row.id === 'tool-subagent');
  assert.equal(spawn.config.toolFilter, undefined);
  assert.equal(spawn.config.modelSelectionSettings, undefined);
  assert.equal(spawn.config.modelSelection, true);
  assert.equal(spawn.config.modelDiscovery, true);
  assert.equal(spawn.config.agentPreset, worker.id);
  assert.equal(spawn.config.maxDepth, 1);
  assert.equal(parentRows.find(row => row.id === 'tool-subagent-fork').config.agentPreset, undefined);
  assert.ok(parentRows.some(row => row.name.endsWith('/list-agents') && !row.disabled));
  assert.ok(childRows.some(row => row.name.endsWith('/list-agents') && !row.disabled));
  assert.equal(childRows.some(row => row.name === '@deepseek-ai/dsh-tool-subagent' ||
    ['tool-workflow', 'tool-ralph', 'workflow-ptc'].includes(row.id)), false);
  for (const id of ['persona', 'redteam-tools', 'skill-filesystem', 'tool-bash', 'tool-fs']) {
    assert.ok(flatten(original.plugins).find(row => row.id === id), id);
    assert.deepEqual(childRows.find(row => row.id === id), flatten(original.plugins).find(row => row.id === id));
  }
  assert.equal(isRedteamPresetId(worker.id), true);
  assert.equal(isRedteamPresetId('unrelated-worker'), false);
});

test('保留用户自定义配置及显式新版模型开关', () => {
  const original = readOriginal();
  original.name = '我的红队';
  const rows = flatten(original.plugins);
  rows.find(row => row.id === 'persona').config.prefix = 'custom persona';
  rows.find(row => row.id === 'tool-subagent').config.modelDiscovery = false;
  const [worker, commander] = prepareSubagentPresets(original);
  assert.equal(commander.name, '我的红队');
  assert.equal(flatten(worker.plugins).find(row => row.id === 'persona').config.prefix, 'custom persona');
  assert.equal(flatten(commander.plugins).find(row => row.id === 'tool-subagent').config.modelDiscovery, false);
});

test('未知旧过滤配置不静默丢弃', () => {
  const original = readOriginal();
  flatten(original.plugins).find(row => row.id === 'tool-subagent').config.toolFilter.deny.push('bash');
  const before = structuredClone(original);
  assert.throws(() => prepareSubagentPresets(original), /无法无损自动迁移/);
  assert.deepEqual(original, before);
});

test('已使用新版预设的声明保持不变', () => {
  const original = { id: 'custom', plugins: [{
    id: 'spawn', name: '@deepseek-ai/dsh-tool-subagent', config: {
      provider: 'spawn', agentPreset: 'custom-worker', modelSelection: false,
    },
  }] };
  assert.deepEqual(prepareSubagentPresets(original), [original]);
});

test('多预设注册部分失败清理，正常卸载逆序且幂等', async () => {
  const calls = [];
  const definitions = [{ id: 'worker' }, { id: 'parent' }];
  const registry = {
    async register(definition) {
      calls.push(`add:${definition.id}`);
      return () => { calls.push(`remove:${definition.id}`); };
    },
  };
  const dispose = await registerPresetDefinitions(registry, definitions);
  await dispose();
  await dispose();
  assert.deepEqual(calls, ['add:worker', 'add:parent', 'remove:parent', 'remove:worker']);
  calls.length = 0;
  const failing = { async register(definition) {
    if (definition.id === 'parent') throw new Error('registration failed');
    return registry.register(definition);
  } };
  await assert.rejects(registerPresetDefinitions(failing, definitions), /registration failed/);
  assert.deepEqual(calls, ['add:worker', 'remove:worker']);
});
