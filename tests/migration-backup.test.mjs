import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupPresetMigration } from '../lib/host-compat/migration-backup.mjs';

test('migration keeps original YAML bytes, reuses valid backup and refuses corrupt backup', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-migration-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dir = path.join(temp, 'preset'), home = path.join(temp, 'home');
  fs.mkdirSync(dir);
  const bytes = Buffer.from('# 用户注释\r\n- name: fixture\r\n');
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), bytes);
  const args = { dir, home, id: 'redteam', definitions: [{ id: 'redteam-worker' }, { id: 'redteam' }] };
  const result = backupPresetMigration(args);
  assert.equal(backupPresetMigration(args), result);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'agent.cordis.yml')), bytes);
  const manifest = JSON.parse(fs.readFileSync(path.join(result, 'manifest.json')));
  assert.deepEqual(manifest.registeredPresets, ['redteam-worker', 'redteam']);
  assert.equal(manifest.sourceUnchanged, true);
  fs.writeFileSync(path.join(result, 'agent.cordis.yml'), 'corrupt');
  assert.throws(() => backupPresetMigration(args), /损坏/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'agent.cordis.yml')), bytes);
});

test('invalid preset ID cannot escape backup root', () => {
  assert.throws(() => backupPresetMigration({ id: '../../outside' }), /编号无效/);
});
