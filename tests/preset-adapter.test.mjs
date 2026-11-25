import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adaptListAgents } from '../lib/host-compat/preset-adapter.mjs';

const name = '@deepseek-ai/dsh-tool-subagent-control';
function fixture(t, source = 'export function registerListAgents() {}') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-adapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'node_modules', name);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
    name, exports: { '.': './index.js', './package.json': './package.json' },
  }));
  fs.writeFileSync(path.join(pkg, 'index.js'), source);
  return { root, anchor: path.join(root, 'package.json') };
}
const definition = () => ({ id: 'redteam', plugins: [
  { id: 'tools', name: 'cordis:group', group: true, config: [
    { id: 'tool-subagent-control', name, disabled: false },
    { id: 'tool-subagent-list-agents', name: name + '/list-agents', disabled: false },
  ] },
] });

test('community adapter removes only redundant legacy declaration, without changing source', t => {
  const { anchor } = fixture(t), before = definition(), copy = structuredClone(before);
  const result = adaptListAgents(before, anchor);
  assert.equal(result.plugins[0].config.length, 1);
  assert.deepEqual(before, copy);
});
test('unknown provider or customized control keeps declaration for visible native errors', t => {
  const f = fixture(t, 'export const unknown = 1;'), def = definition();
  assert.deepEqual(adaptListAgents(def, f.anchor), def);
  const known = fixture(t);
  def.plugins[0].config[0].config = { custom: true };
  assert.deepEqual(adaptListAgents(def, known.anchor), def);
});
test('Direct anchor mapping resolves host capability without writing its manifest', t => {
  const f = fixture(t), symbol = Symbol.for('dsh.go.direct'), previous = globalThis[symbol];
  globalThis[symbol] = { toHost: value => value === '/opt/profile/package.json' ? f.anchor : value };
  try { assert.equal(adaptListAgents(definition(), '/opt/profile/package.json').plugins[0].config.length, 1); }
  finally { if (previous === undefined) delete globalThis[symbol]; else globalThis[symbol] = previous; }
});
