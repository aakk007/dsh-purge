import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';

const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8');

function loadClient(t) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const saved = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage };
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  t.after(() => {
    dom.window.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  let client;
  dom.window.__ModuleLoader__ = {
    load: ({ factory }) => { client = factory((name) => (name === 'react' ? React : ReactDOM)); },
  };
  dom.window.eval(source);
  return client;
}

test('apply() 注册设置入口与插件详情配置区，更新按钮所在的设置页可渲染', t => {
  const client = loadClient(t);
  const registered = [];
  const injected = [];
  const ctx = {
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, register) => { injected.push(name); register(); },
      register: (metadata, component) => { registered.push({ metadata, component }); return () => {}; },
    },
    effect: (fn) => { fn(); return () => {}; },
  };
  client.apply(ctx);

  const byName = (name) => registered.filter((entry) => entry.metadata.name === name);
  assert.deepEqual(injected.sort(), [
    'plugins.bundle.config', 'plugins.row.config', 'settings.section', 'shell.overlay',
  ]);

  const dock = byName('shell.overlay');
  assert.equal(dock.length, 1);
  assert.equal(dock[0].metadata.id, 'dsh-purge-dock');

  const settings = byName('settings.section');
  assert.equal(settings.length, 1, 'DSH 设置里必须有 dsh-purge 一节');
  assert.equal(settings[0].metadata.id, 'dsh-purge');
  assert.equal(settings[0].metadata.order, 40);
  assert.equal(typeof settings[0].metadata.label, 'function');
  assert.equal(settings[0].metadata.label(), 'settings.nav');
  assert.equal(settings[0].metadata.locale, 'settings.dsh-purge');

  const bundle = byName('plugins.bundle.config');
  assert.equal(bundle.length, 1, '插件详情页必须能打开配置');
  assert.equal(bundle[0].metadata.key, 'dsh-purge');

  const row = byName('plugins.row.config');
  assert.equal(row.length, 1);
  assert.equal(row[0].metadata.key, 'dsh-purge#dsh-purge');

  for (const entry of [settings[0], bundle[0], row[0]]) {
    assert.equal(typeof entry.component, 'function');
    assert.deepEqual(entry.metadata.inject(), { t: entry.metadata.inject().t });
  }

  // 设置页本体应包含「破甲」面板（版本通道 + 检查更新/立即更新）。
  const html = renderToStaticMarkup(React.createElement(settings[0].component, { t: (key) => key }));
  assert.match(html, /dshp-root/);
  assert.match(html, /dshp-panel/);
  assert.match(html, /dshp-editions/);
});

test('设置页里的更新按钮走 /dsh-purge/update 的 GET/POST', () => {
  // 版本通道的“检查更新 / 立即更新”就在 PurgifySection：确认两处接口都在。
  assert.match(source, /apiJson\("\/dsh-purge\/update"\)/);
  assert.match(source, /apiJson\("\/dsh-purge\/update",\s*\{/);
  assert.match(source, /t\("btn\.checkUpdate"\)/);
  assert.match(source, /t\("btn\.doUpdate"\)/);
});
