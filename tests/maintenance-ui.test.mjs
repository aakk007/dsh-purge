import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createMaintenancePanel } from '../lib/maintenance-client.js';

test('maintenance UI: error retry, busy state, backup refresh and explicit rollback', async t => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost/' });
  const saved = { window: globalThis.window, document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const calls = [];
  let initialFailure = true, releaseBackup, backups = [];
  const apiJson = async (url, options) => {
    calls.push({ url, options });
    if (!options) {
      if (initialFailure) { initialFailure = false; throw Error('network failed'); }
      return { ok: true, version: '1.0.0', repository: 'aakk007/dsh-purge', backups };
    }
    const body = JSON.parse(options.body);
    if (body.op === 'backup') {
      await new Promise(resolve => { releaseBackup = resolve; });
      backups = [{ id: 'snapshot-1', version: '1.0.0', at: '2026-11-25', files: 2, bytes: 1024, reason: 'manual' }];
      return { ok: true, id: 'snapshot-1' };
    }
    if (body.op === 'rollback') return { ok: true, version: '1.0.0', backup: 'before-rollback' };
    throw Error('unexpected');
  };
  const Panel = createMaintenancePanel({
    h: React.createElement, useState: React.useState, useEffect: React.useEffect, useRef: React.useRef, apiJson,
  });
  const root = createRoot(document.getElementById('app'));
  t.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const button = label => [...document.querySelectorAll('button')].find(node => node.textContent === label);
  await act(async () => { root.render(React.createElement(Panel)); });
  assert.match(document.body.textContent, /network failed/);
  await act(async () => button('刷新 / 重试').click());
  assert.match(document.body.textContent, /暂无插件备份/);
  await act(async () => button('创建备份').click());
  assert(document.querySelector('button').disabled);
  assert.match(document.body.textContent, /正在执行维护/);
  await act(async () => releaseBackup());
  assert.match(document.body.textContent, /备份完成/);
  await act(async () => button('选择回滚').click());
  assert.equal(calls.filter(call => call.options && JSON.parse(call.options.body).op === 'rollback').length, 0);
  await act(async () => button('取消').click());
  assert.equal(button('确认回滚'), undefined);
  await act(async () => button('选择回滚').click());
  await act(async () => button('确认回滚').click());
  assert.match(document.body.textContent, /请手动重启宿主加载/);
  assert.equal(calls.filter(call => call.options && JSON.parse(call.options.body).op === 'rollback').length, 1);
});
