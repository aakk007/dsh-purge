import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifestPath = new URL('../package.json', import.meta.url);
const indexPath = new URL('../index.json', import.meta.url);
const manifestBytes = readFileSync(manifestPath);
const indexBytes = readFileSync(indexPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const index = JSON.parse(indexBytes.toString('utf8'));

/**
 * 二次编码（UTF-8 被当成 GBK 读再写成 UTF-8）留下的固定片段。
 * 1.1.74 的描述就是这样被写坏的：插件详情页显示成「鐮寸敳锛氳…」。
 */
const MOJIBAKE = /[\uFFFD]|锛|鐮|鈥|缃戠|绾㈤|鏀惰棌|鎻愮ず|銆/;

test('package.json：清单是干净 UTF-8，描述与关键词没有被二次编码', () => {
  assert.notEqual(manifestBytes[0], 0xef, 'package.json 不应带 UTF-8 BOM');
  assert.equal(typeof manifest.description, 'string');
  for (const word of ['破甲', '小码酱', 'Jailbreak', '署名']) {
    assert.ok(manifest.description.includes(word), `描述里缺少「${word}」：${manifest.description}`);
  }
  assert.equal(MOJIBAKE.test(manifest.description), false, `描述出现二次编码：${manifest.description}`);
  const keywords = (manifest.keywords || []).join(' ');
  for (const word of ['网络安全', '红队评测']) {
    assert.ok(keywords.includes(word), `关键词里缺少「${word}」`);
  }
  assert.equal(MOJIBAKE.test(keywords), false, '关键词出现二次编码');
});

test('发布索引与清单版本、安装地址一致', () => {
  assert.notEqual(indexBytes[0], 0xef, 'index.json 不应带 UTF-8 BOM');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const plugin = index.plugins.find((entry) => entry.name === manifest.name);
  assert.ok(plugin, `索引里没有 ${manifest.name}`);
  const version = plugin.versions[0];
  assert.equal(version.version, manifest.version, '索引版本必须与 package.json 一致');
  const tag = `v${manifest.version}`;
  assert.ok(manifest.dsh.install.tarball.endsWith(`/tags/${tag}.tar.gz`), manifest.dsh.install.tarball);
  assert.ok(manifest.dsh.install.zip.endsWith(`/tags/${tag}.zip`), manifest.dsh.install.zip);
  assert.match(version.source.commit, /^[0-9a-f]{40}$/);
  if (version.title !== undefined) assert.equal(MOJIBAKE.test(JSON.stringify(version)), false);
  if (plugin.description !== undefined) assert.equal(MOJIBAKE.test(JSON.stringify(plugin.description)), false);
});
