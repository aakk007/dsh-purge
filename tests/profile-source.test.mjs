import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateProfileSource } from '../lib/profile-source.js';

test('profile source migration preserves other fields and lockfile; backs up exact bytes; idempotent', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-profile-migration-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const profile = path.join(temp, 'profile'), home = path.join(temp, 'home');
  fs.mkdirSync(profile);
  const pkg = { dependencies: { 'dsh-purge': 'old', unrelated: 'keep' }, dsh: { permissions: 'keep' } };
  const original = Buffer.from(JSON.stringify(pkg, null, '\t') + '\r\n');
  fs.writeFileSync(path.join(profile, 'package.json'), original);
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'original lock');
  const args = { profile, home, url: 'https://codeload.github.com/aakk007/dsh-purge/tar.gz/' + 'a'.repeat(40) };
  const result = migrateProfileSource(args);
  assert.equal(result.changed, true);
  assert.deepEqual(fs.readFileSync(result.backup), original);
  const after = JSON.parse(fs.readFileSync(path.join(profile, 'package.json')));
  assert.equal(after.dependencies.unrelated, 'keep');
  assert.deepEqual(after.dsh, pkg.dsh);
  assert.equal(after.dependencies['dsh-purge'], args.url);
  assert.equal(fs.readFileSync(path.join(profile, 'pnpm-lock.yaml'), 'utf8'), 'original lock');
  assert.deepEqual(migrateProfileSource(args), { changed: false });
  assert.throws(() => migrateProfileSource({ ...args, url: 'https://example.invalid/pkg.tgz' }), /固定到本仓库/);
});
