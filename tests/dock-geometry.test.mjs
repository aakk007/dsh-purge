import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url));
const source = readFileSync(clientPath, 'utf8');

/**
 * 在 jsdom 里执行 client.js 的 ModuleLoader 工厂，拿到停靠面板的几何函数。
 * 宿主（dshgo）的 --dsh-app-* 变量用假的 getComputedStyle 提供，必要时为 null
 * 表示官方 Web / 桌面浏览器（没有这些变量）。
 */
function loadDockGeometry(t, { vars = null, innerWidth = 1280, innerHeight = 800 } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const saved = {
    window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage,
  };
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  });
  Object.defineProperty(dom.window, 'innerWidth', { value: innerWidth, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: innerHeight, configurable: true });
  if (vars) {
    dom.window.getComputedStyle = () => ({ getPropertyValue: (name) => vars[name] ?? '' });
  }
  t.after(() => {
    dom.window.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  let client;
  dom.window.__ModuleLoader__ = {
    load: ({ factory }) => {
      client = factory((name) => (name === 'react' ? React : ReactDOM));
    },
  };
  dom.window.eval(source);
  assert.equal(client.name, 'dsh-purge');
  assert.ok(client.__dockGeometry, 'client.js must expose dock geometry for tests');
  return { ...client.__dockGeometry, dom };
}

test('dshgo 手机：停靠面板让开返回/菜单按钮与手势条', t => {
  const g = loadDockGeometry(t, {
    innerWidth: 390, innerHeight: 844,
    vars: {
      '--dsh-app-inset-top': '96px',
      '--dsh-app-lead-h': '60px',
      '--dsh-app-inset-bottom': '24px',
      '--dsh-app-inset-left': '0px',
      '--dsh-app-inset-right': '0px',
      '--dsh-app-status': '24px',
      '--dsh-app-band': '0px',
    },
  });
  assert.deepEqual(g.appChromeInsets(), { top: 96, right: 0, bottom: 24, left: 0 });
  const geom = g.clampDockGeom({ x: 8, y: 48, w: 620, h: 520 });
  assert.ok(geom.y >= 96 + 8, `面板顶边必须在返回/菜单按钮下方，实际 ${geom.y}`);
  assert.ok(geom.x >= 8, `左边距实际 ${geom.x}`);
  assert.ok(geom.x + geom.w <= 390 - 8, `右边距越界：${geom.x}+${geom.w}`);
  assert.ok(geom.w <= 390 - 16, `宽度越界：${geom.w}`);
  assert.ok(geom.y + geom.h <= 844 - 24 - 8, `高度越界：${geom.h}`);
  const preset = g.defaultDockGeom();
  assert.equal(preset.y, 96 + 8);
  assert.ok(preset.x + preset.w <= 390 - 8);
  assert.ok(preset.h >= 240);
});

test('dshgo 桌面布局：让开状态栏与顶部 band', t => {
  const g = loadDockGeometry(t, {
    innerWidth: 1600, innerHeight: 1000,
    vars: {
      '--dsh-app-inset-top': '24px',
      '--dsh-app-status': '24px',
      '--dsh-app-band': '52px',
      '--dsh-app-inset-bottom': '0px',
    },
  });
  assert.equal(g.appChromeInsets().top, 76);
  const geom = g.clampDockGeom({ x: 900, y: 12, w: 620, h: 700 });
  assert.ok(geom.y >= 76 + 8);
  assert.equal(geom.w, 620);
});

test('官方 Web / 桌面浏览器：没有宿主变量时保持原位置', t => {
  const g = loadDockGeometry(t, { vars: {} });
  assert.deepEqual(g.appChromeInsets(), { top: 0, right: 0, bottom: 0, left: 0 });
  const geom = g.clampDockGeom({ x: 8, y: 8, w: 620, h: 520 });
  assert.deepEqual(geom, { x: 8, y: 8, w: 620, h: 520 });
  assert.deepEqual(g.defaultDockGeom(), { x: 1280 - 620 - 8, y: 8, w: 620, h: Math.max(240, Math.min(640, 800 - 8 - 172)) });
});

test('停靠面板 CSS 不再用固定最小宽度，并给遮罩留出安全区', () => {
  assert.match(source, /\.dshp-dock\{[^}]*min-width:min\(380px,calc\(100vw - 16px\)\)/);
  assert.match(source, /:root\[data-dsh-app-layout\] \.dshp-dock\{max-width:calc\(100vw - var\(--dsh-app-inset-left,0px\)/);
  assert.match(source, /\.dshp-auth-mask\{[^}]*padding:calc\(20px \+ var\(--dsh-app-inset-top,0px\)\)/);
});
