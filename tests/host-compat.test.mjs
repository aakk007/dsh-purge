import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installCompat, ensureDshGoCompat } from '../lib/host-compat/subagent-list-agents.mjs';
import { readPresetDefinition } from '../lib/redteam/preset-composition.js';

const prefix = process.env.DSH_TEST_PREFIX;
const options = { skip: !prefix && 'set DSH_TEST_PREFIX to pristine official 0.2.2-rc.1 dependencies' };
const packageName = '@deepseek-ai/dsh-tool-subagent-control';
const root = fileURLToPath(new URL('../', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(resolve(prefix), 'purge-host-compat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, 'node_modules', packageName);
  mkdirSync(pkg, { recursive: true });
  cpSync(join(prefix, 'node_modules', packageName), pkg, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  return { dir, pkg, manifest: join(pkg, 'package.json'), require: createRequire(join(dir, 'package.json')) };
}

function controlRows() {
  const definition = readPresetDefinition('redteam', join(root, 'presets/redteam'));
  const walk = rows => rows.flatMap(row => row.group ? walk(row.config) : [row]);
  return walk(definition.plugins).filter(row => row.name === packageName || row.name === `${packageName}/list-agents`);
}

test('随包原预设保留两个启用入口', () => {
  const rows = controlRows();
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.disabled, false);
  assert.ok(rows.some(row => row.name.endsWith('/list-agents')));
});

test('官方包原样复现旧导出缺失', options, t => {
  const f = fixture(t);
  assert.throws(() => f.require.resolve(`${packageName}/list-agents`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('DSH Go 启动策略：识别宿主、安装、重复启动、回滚，主实现不变', options, t => {
  const f = fixture(t);
  const original = readFileSync(f.manifest);
  const main = readFileSync(join(f.pkg, 'lib/index.js'));
  const marker = join(f.dir, 'bridge-package.json');
  const args = { prefix: f.dir, marker, platform: 'linux' };
  assert.equal(ensureDshGoCompat(args).state, 'not-dsh-go');
  writeFileSync(marker, '{}');
  assert.equal(ensureDshGoCompat({ ...args, platform: 'win32' }).state, 'not-dsh-go');
  assert.equal(ensureDshGoCompat({ ...args, mode: 'off' }).state, 'disabled');
  assert.deepEqual(readFileSync(f.manifest), original);
  assert.equal(ensureDshGoCompat(args).liveResolution, true);
  assert.equal(ensureDshGoCompat(args).state, 'unchanged');
  assert.equal(installCompat(f.dir, { check: true }).state, 'installed');
  assert.deepEqual(readFileSync(join(f.pkg, 'lib/index.js')), main);
  assert.equal(ensureDshGoCompat({ ...args, mode: 'restore' }).state, 'restored');
  assert.deepEqual(readFileSync(f.manifest), original);
  assert.deepEqual(readFileSync(`${f.manifest}.dsh-go-list-agents-original`), original);
  assert.equal(existsSync(join(f.pkg, 'lib/dsh-go-list-agents-compat.mjs')), false);
});

test('Direct 默认启动路径使用宿主适配器，保留原预设并可回滚', options, t => {
  const f = fixture(t);
  const marker = join(f.dir, 'bridge-package.json');
  writeFileSync(marker, '{}');
  const key = Symbol.for('dsh.go.direct');
  const previous = globalThis[key];
  const mapped = [];
  globalThis[key] = {
    toHost(path) {
      mapped.push(path);
      if (path === '/opt/dsh') return f.dir;
      if (path === '/opt/dsh-go/dsh-go-bridge/package.json') return marker;
      return path;
    },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  });
  const original = readFileSync(f.manifest);
  // 不注入 prefix/marker，覆盖之前测试遗漏的真实默认启动入口。
  assert.equal(ensureDshGoCompat({ platform: 'linux' }).state, 'installed');
  assert.deepEqual(mapped, ['/opt/dsh', '/opt/dsh-go/dsh-go-bridge/package.json']);
  assert.equal(ensureDshGoCompat({ platform: 'linux' }).state, 'unchanged');
  assert.equal(ensureDshGoCompat({ platform: 'linux', mode: 'restore' }).state, 'restored');
  assert.deepEqual(readFileSync(f.manifest), original);
});

test('未知版本跳过，未知字节和冲突入口不覆盖', options, t => {
  const f = fixture(t);
  const original = readFileSync(f.manifest);
  const marker = join(f.dir, 'bridge-package.json');
  writeFileSync(marker, '{}');
  const metadata = JSON.parse(original);
  metadata.version = '0.2.3';
  writeFileSync(f.manifest, JSON.stringify(metadata));
  assert.equal(ensureDshGoCompat({ prefix: f.dir, marker, platform: 'linux' }).state, 'unsupported-version');
  assert.equal(existsSync(`${f.manifest}.dsh-go-list-agents-original`), false);
  writeFileSync(f.manifest, Buffer.concat([original, Buffer.from('\n')]));
  assert.throws(() => installCompat(f.dir), /摘要不匹配/);
  writeFileSync(f.manifest, original);
  writeFileSync(join(f.pkg, 'lib/dsh-go-list-agents-compat.mjs'), 'user content');
  assert.throws(() => installCompat(f.dir), /已有其他内容/);
  assert.deepEqual(readFileSync(f.manifest), original);
});

test('CLI 安装、全新进程解析和 CLI 回滚', options, t => {
  const f = fixture(t);
  const run = (...args) => {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const installer = join(root, 'lib/host-compat/subagent-list-agents.mjs');
  assert.equal(JSON.parse(run(installer, '--prefix', f.dir)).state, 'installed');
  const code = `import {createRequire} from 'node:module'; const req=createRequire(${JSON.stringify(join(f.dir, 'package.json'))}); console.log(req.resolve('${packageName}/list-agents'));`;
  assert.match(run('--input-type=module', '-e', code), /dsh-go-list-agents-compat\.mjs/);
  assert.equal(JSON.parse(run(installer, '--prefix', f.dir, '--restore')).state, 'restored');
  assert.equal(JSON.parse(run(installer, '--prefix', f.dir, '--check')).state, 'needs-update');
});

test('官方预设注册器：复现 never started，补盘后缓存仍失败，热修后原入口可用', options, async t => {
  const f = fixture(t);
  const load = name => import(pathToFileURL(f.require.resolve(name)).href);
  const [{ Context }, { Loader }, { ToolsService }, { AgentPresetRegistry }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/cordis-plugin-loader'),
    load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-agent-preset-registry'),
  ]);
  const ctx = new Context();
  ctx.baseUrl = pathToFileURL(join(f.dir, 'package.json')).href;
  t.after(() => ctx.fiber.dispose());
  ctx.provide('systemPrompt', { tools: () => () => {} });
  ctx.provide('subagents', { async listChildren() { return []; } });
  ctx.provide('agents', new Map());
  ctx.provide('sessionProjections', { register: async () => ({}) });
  await ctx.plugin(ToolsService);
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(f.dir, 'package.json')).href });
  if (process.execArgv.includes('--expose-internals')) assert.ok(ctx.loader.internal);
  await ctx.plugin(AgentPresetRegistry, { default: 'redteam' });
  const registry = ctx.get('agentPresets');
  const definition = { id: 'redteam', name: '红队模式', plugins: controlRows() };
  const original = structuredClone(definition);
  let unregister = await registry.register(definition);
  const expectedFailure = `tool-subagent-list-agents (${packageName}/list-agents): never started`;
  assert.equal((await registry.list())[0].broken, expectedFailure);
  await unregister();
  installCompat(f.dir);
  unregister = await registry.register(definition);
  assert.equal((await registry.list())[0].broken, expectedFailure);
  await unregister();

  const marker = join(f.dir, 'bridge-package.json');
  writeFileSync(marker, '{}');
  const args = { prefix: f.dir, marker, platform: 'linux' };
  const result = ensureDshGoCompat(args);
  try {
    assert.equal(result.liveResolution, true);
    assert.equal(result.restartRequired, false);
    unregister = await registry.register(definition);
    assert.equal((await registry.list())[0].broken, undefined);
    const generation = [...registry.generations.values()][0];
    const tools = generation.scope.ctx.get('tools');
    assert.deepEqual(tools.definitions(generation.key).map(tool => tool.name).sort(),
      ['interrupt_agent', 'list_agents', 'send_message']);
    assert.deepEqual(await tools.get('list_agents', generation.key).execute({}, { agent: { id: 'parent' } }), []);
    assert.deepEqual(definition, original);
    await unregister();

    // 补丁只作用于已核验宿主，不给另一份未修补包伪造导出。
    const other = fixture(t);
    assert.throws(() => other.require.resolve(`${packageName}/list-agents`),
      { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    const standalone = fixture(t);
    const metadata = JSON.parse(readFileSync(standalone.manifest));
    metadata.exports = { './list-agents': './lib/index.js' };
    writeFileSync(standalone.manifest, JSON.stringify(metadata));
    assert.equal(standalone.require.resolve(`${packageName}/list-agents`),
      join(standalone.pkg, 'lib/index.js'));
  } finally {
    ensureDshGoCompat({ ...args, mode: 'restore' });
  }
});

for (const legacyFirst of [false, true]) {
  test(`真实 Loader / ToolsService 加载原预设入口：${legacyFirst ? 'legacy first' : 'main first'}`, options, async t => {
    const f = fixture(t);
    installCompat(f.dir);
    const load = name => import(pathToFileURL(f.require.resolve(name)).href);
    const [{ Context }, { Loader }, { ToolsService }] = await Promise.all([
      load('@deepseek-ai/cordis'), load('@deepseek-ai/cordis-plugin-loader'), load('@deepseek-ai/dsh-tools'),
    ]);
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    ctx.provide('systemPrompt', { tools: () => () => {} });
    ctx.provide('subagents', { async listChildren(id) {
      assert.equal(id, 'parent');
      return [{ id: 'child', label: 'fixture', mode: 'continuable' }];
    } });
    ctx.provide('agents', new Map([['child', { status: 'running' }]]));
    await ctx.plugin(ToolsService);
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(f.dir, 'package.json')).href });
    const rows = controlRows();
    if (legacyFirst) rows.reverse();
    const original = structuredClone(rows);
    await ctx.loader.root.update(rows);
    for (const row of rows) {
      await ctx.loader.resolve(row.id).fiber.await();
      assert.equal(ctx.loader.resolve(row.id).fiber.state, 2);
    }
    assert.deepEqual(rows, original);
    const tools = ctx.get('tools');
    assert.deepEqual(tools.definitions().map(tool => tool.name).sort(), ['interrupt_agent', 'list_agents', 'send_message']);
    assert.deepEqual(await tools.get('list_agents').execute({}, { agent: { id: 'parent' } }),
      [{ kind: 'child', id: 'child', label: 'fixture', status: 'running' }]);
    await ctx.loader.update('tool-subagent-list-agents', { disabled: true });
    assert.equal(tools.definitions().length, 3);
    await ctx.loader.update('tool-subagent-list-agents', { disabled: false });
    assert.equal(ctx.loader.resolve('tool-subagent-list-agents').fiber.state, 2);
    await ctx.loader.update('tool-subagent-control', { disabled: true });
    assert.equal(tools.get('list_agents'), undefined);
    await ctx.loader.update('tool-subagent-control', { disabled: false });
    assert.equal(tools.definitions().length, 3);
  });
}
