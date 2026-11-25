import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const prefix = process.env.DSH_MARKET_TEST_PREFIX;
const sourceFile = process.env.DSH_MARKET_SOURCE;
const options = { skip: (!prefix || !sourceFile) && 'provide official market-index dependencies and market lib/index.js' };
const rawIndex = JSON.parse(readFileSync(new URL('../index.json', import.meta.url), 'utf8'));
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const indexUrl = 'https://raw.githubusercontent.com/aakk007/dsh-purge/master/index.json';

async function officialSelector() {
  const require = createRequire(join(resolve(prefix), 'package.json'));
  const { parseMarketIndex, marketInstallTarget } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-market-index')).href);
  const semver = require('semver');
  const source = readFileSync(sourceFile, 'utf8');
  const metadata = JSON.parse(readFileSync(join(dirname(sourceFile), '..', 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@deepseek-ai/dsh-plugin-market');
  assert.equal(metadata.version, '0.2.2-rc.1');
  // 直接运行官方包的 listingOf / installationOf，防止测试复写选版规则而遗漏稳定版优先。
  const start = source.indexOf('function listingOf(');
  const end = source.indexOf('function compatibilityOf(', start);
  assert.ok(start >= 0 && end > start);
  const listingOf = runInNewContext(`${source.slice(start, end)}\nlistingOf`, {
    semver,
    marketInstallTarget,
    compatibilityOf(_name, version) {
      // 本索引不设引擎限制；仅隔离兼容性判定，不替代要验证的官方选版逻辑。
      assert.equal(version.engines.dsh, undefined);
      return { compatible: true };
    },
  });
  return { parseMarketIndex, listingOf };
}

test('复现截图：旧稳定版与较新预发布版共存时，官方页面仍默认选 1.1.71', options, async () => {
  const { parseMarketIndex, listingOf } = await officialSelector();
  const previous = structuredClone(rawIndex);
  previous.plugins[0].versions.push({
    version: '1.1.71',
    publishTimestamp: 1791869432,
    source: { type: 'git', url: 'https://github.com/aakk007/dsh-purge.git', commit: '033e6bd1e0f101352b39075ecd0d758ffef26b76' },
  });
  const listing = listingOf(parseMarketIndex(previous, indexUrl).plugins[0], [], {}, '0.2.2-rc.1');
  assert.equal(listing.defaultVersion, '1.1.71');
});

test('发布索引让官方页面默认选修复版，并为已装 1.1.71 提供正确更新目标', options, async () => {
  const { parseMarketIndex, listingOf } = await officialSelector();
  const plugin = parseMarketIndex(rawIndex, indexUrl).plugins[0];
  const listing = listingOf(plugin, [{ name: 'dsh-purge', installed: true, version: '1.1.71' }], {}, '0.2.2-rc.1');
  assert.equal(listing.defaultVersion, packageVersion);
  assert.equal(listing.installation.status, 'update-available');
  const selected = listing.versions.find(version => version.version === listing.defaultVersion);
  assert.equal(selected.install.spec, `git+https://github.com/aakk007/dsh-purge.git#${rawIndex.plugins[0].versions[0].source.commit}`);
});

test('已安装 .4 时官方市场提示更新到当前发行版', options, async () => {
  const { parseMarketIndex, listingOf } = await officialSelector();
  const plugin = parseMarketIndex(rawIndex, indexUrl).plugins[0];
  const listing = listingOf(plugin, [
    { name: 'dsh-purge', installed: true, version: '1.1.72-dshgo.4' },
  ], {}, '0.2.2-rc.1');
  assert.equal(listing.installation.status, 'update-available');
  assert.equal(listing.defaultVersion, packageVersion);
  assert.notEqual(listing.defaultVersion, '1.1.72-dshgo.4');
  const target = listing.versions.find(item => item.version === listing.defaultVersion);
  assert.equal(target.install.spec, `git+https://github.com/aakk007/dsh-purge.git#${rawIndex.plugins[0].versions[0].source.commit}`);
});

test('安装当前发行版后不再提示重复更新', options, async () => {
  const { parseMarketIndex, listingOf } = await officialSelector();
  const plugin = parseMarketIndex(rawIndex, indexUrl).plugins[0];
  const listing = listingOf(plugin, [
    { name: 'dsh-purge', installed: true, version: packageVersion },
  ], {}, '0.2.2-rc.1');
  assert.equal(listing.defaultVersion, packageVersion);
  assert.notEqual(listing.installation.status, 'update-available');
});
