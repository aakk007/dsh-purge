import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readPresetDefinition } from '../lib/redteam/preset-composition.js';
import { prepareSubagentPresets, registerPresetDefinitions } from '../lib/host-compat/subagent-presets.mjs';
import { ensureDshGoCompat } from '../lib/host-compat/subagent-list-agents.mjs';

const prefix = process.env.DSH_FULL_TEST_PREFIX;
test('完整官方 Web 宿主加载整份红队预设，复现旧配置失败并验证执行预设', {
  skip: !prefix && 'set DSH_FULL_TEST_PREFIX to an isolated official @deepseek-ai/dsh@0.2.2-rc.1 installation',
  timeout: 90_000,
}, async (t) => {
  const directory = resolve(prefix);
  const home = mkdtempSync(join(directory, 'redteam-full-test-'));
  const savedHome = process.env.DSH_HOME;
  const savedTelemetry = process.env.DSH_TELEMETRY_DISABLED;
  process.env.DSH_HOME = home;
  process.env.DSH_TELEMETRY_DISABLED = '1';
  const req = createRequire(join(directory, 'package.json'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const load = name => import(pathToFileURL(req.resolve(name)).href);
  const marker = join(home, 'bridge-package.json');
  writeFileSync(marker, '{}');
  const args = { prefix: directory, marker, platform: 'linux' };
  let shutdown;
  let disposePresets;
  let agentHandle;
  const leases = [];
  try {
    ensureDshGoCompat(args);
    const bin = req.resolve('@deepseek-ai/dsh/package.json');
    const { prepareProfile, runProfile } = await import(pathToFileURL(join(dirname(bin), 'lib/profile-boot.js')).href);
    const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment');
    const profile = prepareProfile('web');
    mkdirSync(join(profile.dir, 'node_modules'), { recursive: true });
    symlinkSync(root, join(profile.dir, 'node_modules/dsh-purge'), process.platform === 'win32' ? 'junction' : 'dir');
    const manifestPath = join(profile.dir, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies ??= {};
    manifest.dependencies['dsh-purge'] = `file:${root.replaceAll('\\', '/')}`;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    // 实际 Web 服务仅监听临时本地端口，不打开浏览器，不输出连接凭据。
    const patch = join(home, 'test.patch.yml');
    writeFileSync(patch, JSON.stringify([
      { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
      { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: false } },
    ]));
    const app = await runProfile({
      profile: 'web', patchFiles: [patch], args: [],
      environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: {
        DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
      } }]),
    });
    shutdown = app.shutdown;
    const registry = app.ctx.get('agentPresets');
    assert.ok(registry);
    const original = readPresetDefinition('redteam', join(root, 'presets/redteam'));
    const failedRelease = await registry.register(original);
    const failed = (await registry.list()).find(row => row.id === 'redteam');
    assert.match(failed.broken, /toolFilter is no longer supported/);
    await failedRelease();

    const definitions = prepareSubagentPresets(original);
    disposePresets = await registerPresetDefinitions(registry, definitions);
    const listed = await registry.list();
    for (const definition of definitions) {
      const row = listed.find(preset => preset.id === definition.id);
      assert.ok(row, definition.id);
      assert.equal(row.broken, undefined, `${definition.id}: ${row.broken}`);
    }
    const commanderLease = await registry.acquireScope('redteam');
    leases.push(commanderLease);
    const workerLease = await registry.acquireScope('redteam-worker');
    leases.push(workerLease);
    const commanderScope = commanderLease.key;
    const workerScope = workerLease.key;
    const tools = app.ctx.get('tools');
    assert.ok(tools.get('subagent', commanderScope));
    assert.ok(tools.get('subagent_fork', commanderScope));
    assert.ok(tools.get('list_subagent_models', commanderScope));
    for (const name of ['subagent', 'subagent_fork', 'workflow', 'ralph']) {
      assert.equal(tools.get(name, workerScope), undefined, name);
    }
    assert.ok(tools.get('list_agents', workerScope));
    assert.ok(tools.get('send_message', workerScope));

    // 创建空会话，执行真正的官方工具；在启动边界捕获请求，不发送模型请求。
    agentHandle = await app.ctx.get('agents').create({
      sessionId: randomUUID(),
      meta: { cwd: home },
      setup: async ctx => { await registry.mount(ctx, 'redteam'); },
    });
    let activation;
    const intercepted = t.mock.method(app.ctx.get('subagents'), 'startActivation', async spec => {
      activation = spec;
      return { childId: 'offline-test-child' };
    });
    try {
      const value = await tools.get('subagent', commanderScope).execute({
        description: 'compatibility test', prompt: 'offline compatibility test',
      }, { agent: agentHandle.agent, signal: new AbortController().signal });
      assert.equal(value.subagentId, 'offline-test-child');
      assert.equal(activation.provider, 'spawn');
      assert.equal(activation.request.agentPreset, 'redteam-worker');
      assert.equal(activation.request.maxDepth, 1);
      assert.equal(activation.request.parent, agentHandle.agent);
    } finally {
      intercepted.mock.restore();
    }
  } finally {
    const cleanupErrors = [];
    for (const cleanup of [
      () => agentHandle?.dispose(),
      ...leases.reverse().map(lease => () => lease[Symbol.asyncDispose]()),
      () => disposePresets?.(),
      () => shutdown?.shutdown(0),
      () => ensureDshGoCompat({ ...args, mode: 'restore' }),
      () => {
        if (savedHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = savedHome;
        if (savedTelemetry === undefined) delete process.env.DSH_TELEMETRY_DISABLED;
        else process.env.DSH_TELEMETRY_DISABLED = savedTelemetry;
        // 删除的仅为本测试在隔离安装下创建的临时 home。
        assert.equal(dirname(home), directory);
        rmSync(home, { recursive: true, force: true });
      },
    ]) {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'test cleanup failed');
  }
});
