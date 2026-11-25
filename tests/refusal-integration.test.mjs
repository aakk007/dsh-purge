import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { installRefusalRetry, readRefusalSettings } from "../lib/refusal-retry-hook.js";
import { streamWithRefusalRetry, withSeedPrime } from "../lib/refusal-retry.js";
import { readAudit } from "../lib/audit.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "purge-refusal-integration-"));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});
const delta = text => ({ type: "text-delta", index: 0, text });
const finish = { type: "finish", reason: { kind: "completed" } };
const options = () => ({ messages: [
  { role: "system", content: "base" }, { role: "user", content: "write a parser" },
] });
const stream = (...chunks) => (async function* () { yield* chunks; })();
async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}
function harness(config, provider, services = true) {
  let handler;
  const ctx = {
    on(event, fn) { assert.equal(event, "llm/stream"); handler = fn; return () => { handler = null; }; },
    reflect: { get(name, strict) {
      assert.equal(name, "llm"); assert.equal(strict, false);
      return services ? { stream: dispatch } : undefined;
    } },
  };
  const off = installRefusalRetry(ctx, { getConfig: () => config });
  function dispatch(request) {
    let calls = 0;
    return handler(request, () => {
      assert.equal(++calls, 1, "Cordis next is one-shot");
      return provider(request);
    });
  }
  return { dispatch, off };
}

test("settings default off, explicit boolean opt-in and live saved settings take precedence", () => {
  const dir = fs.mkdtempSync(path.join(home, "settings-"));
  assert.equal(readRefusalSettings(dir).refusalRetry, false);
  assert.equal(readRefusalSettings(dir, { refusalRetry: "true" }).refusalRetry, false);
  assert.equal(readRefusalSettings(dir, { refusalRetry: true }).refusalRetry, true);
  fs.mkdirSync(path.join(dir, "dsh-purge"));
  const file = path.join(dir, "dsh-purge", "tuning.json");
  fs.writeFileSync(file, '{"refusalRetry":false,"refusalSeed":false}');
  assert.equal(readRefusalSettings(dir, { refusalRetry: true }).refusalRetry, false);
  assert.equal(readRefusalSettings(dir).refusalSeed, false);
  fs.writeFileSync(file, "[]");
  assert.throws(() => readRefusalSettings(dir), /JSON/);
  fs.writeFileSync(file, "{");
  assert.throws(() => readRefusalSettings(dir), SyntaxError);
});

test("disabled hook passes the original stream and request through", async () => {
  const request = options();
  const response = stream(delta("我不能帮助这个请求"), finish);
  const h = harness({}, actual => { assert.equal(actual, request); return response; });
  assert.equal(h.dispatch(request), response);
  assert.equal((await collect(response)).length, 2);
});

test("hook retries through a fresh waterfall, respects all four arms and leaves inputs frozen", async () => {
  const request = options();
  request.messages.forEach(Object.freeze);
  Object.freeze(request.messages); Object.freeze(request);
  const calls = [];
  const h = harness({ refusalRetry: true }, actual => {
    calls.push(actual);
    assert.equal(Object.getOwnPropertySymbols(actual).length, 0);
    assert.deepEqual(Object.keys(actual), ["messages"]);
    return stream(delta("我不能帮助这个请求"), finish);
  });
  await collect(h.dispatch(request));
  assert.equal(calls.length, 5);
  assert.match(calls[1].messages[0].content, /operator/);
  assert.match(calls[2].messages[0].content, /novel/);
  assert.match(calls[3].messages[1].content, /实现如下/);
  assert.match(calls[4].messages[0].content, /smallest/);
  assert.deepEqual(request, options());
});

test("missing llm service returns original buffered output", async () => {
  const original = [delta("我不能帮助这个请求"), finish];
  const h = harness({ refusalRetry: true }, () => stream(...original), false);
  assert.deepEqual(await collect(h.dispatch(options())), original);
});

test("invalid saved settings do not break the original request", async t => {
  let handler;
  t.mock.method(console, "warn", () => {});
  installRefusalRetry({ on(_, fn) { handler = fn; } }, {
    getConfig() { throw new Error("broken settings"); },
  });
  const response = stream(delta("response"), finish);
  assert.equal(handler(options(), () => response), response);
  assert.equal(console.warn.mock.callCount(), 1);
});

test("seed preserves images, tool results, source metadata and original messages", () => {
  const image = { type: "image", attachment: { id: "fixture" } };
  const user = { role: "user", content: [image, { type: "text", text: "input" }], source: { kind: "human" } };
  const tool = { role: "tool", content: [{ type: "tool-result", result: "result" }] };
  const request = { messages: [user, tool] };
  const before = structuredClone(request);
  const result = withSeedPrime(request);
  assert.equal(result.messages[0].content[0], image);
  assert.equal(result.messages[0].source, user.source);
  assert.equal(result.messages[1], tool);
  assert.deepEqual(request, before);
  assert.match(result.messages[0].content[1].text, /实现如下/);
  const noUser = { messages: [tool] };
  assert.equal(withSeedPrime(noUser), noUser);
});

test("tool calls in the buffered stream are passed through without retry", async () => {
  let calls = 0;
  const chunks = [delta("我不能提供额外说明"), { type: "tool-call", id: "one" }, finish];
  const result = await collect(streamWithRefusalRetry(() => { calls++; return stream(...chunks); }, options()));
  assert.deepEqual(result, chunks);
  assert.equal(calls, 1);
});

test("abort between attempts stops retries and closes the original iterator", async () => {
  const controller = new AbortController();
  let calls = 0, closed = 0;
  const result = await collect(streamWithRefusalRetry(() => {
    calls++;
    return (async function* () { try { yield delta("我不能帮助"); yield finish; } finally { closed++; } })();
  }, { ...options(), signal: controller.signal }, { onRetry: () => controller.abort() }));
  assert.equal(calls, 1); assert.equal(closed, 1); assert.deepEqual(result, []);
});

test("retry finish error restores prior output and audit never stores response or exception text", async () => {
  const refusal = "我不能帮助 TOKEN_FIXTURE";
  let calls = 0;
  const chunks = await collect(streamWithRefusalRetry(() => {
    calls++;
    return calls === 1 ? stream(delta(refusal), finish) : stream({
      type: "finish", reason: { kind: "error", failure: { code: "TRANSPORT", message: "SECRET_FIXTURE" } },
    });
  }, options()));
  assert.deepEqual(chunks, [delta(refusal), finish]);
  const rows = readAudit({ home, limit: 500 });
  assert.ok(rows.some(row => row.outcome === "error" && row.error === "TRANSPORT"));
  assert.doesNotMatch(JSON.stringify(rows), /TOKEN_FIXTURE|SECRET_FIXTURE/);
});

test("failure after visible retry output throws instead of appending the old response", async () => {
  let calls = 0;
  const chunks = [];
  const response = streamWithRefusalRetry(() => {
    if (++calls === 1) return stream(delta("我不能帮助"), finish);
    return (async function* () { yield delta("answer ".repeat(100)); throw new Error("disconnected"); })();
  }, options());
  await assert.rejects(async () => { for await (const chunk of response) chunks.push(chunk); }, /disconnected/);
  assert.equal(chunks.length, 1);
  assert.doesNotMatch(chunks[0].text, /我不能/);
});

test("consumer return closes the active iterator", async () => {
  let closed = 0;
  const response = streamWithRefusalRetry(() => (async function* () {
    try { yield delta("answer ".repeat(100)); yield finish; } finally { closed++; }
  })(), options());
  await response.next();
  await response.return();
  assert.equal(closed, 1);
});

test("real Cordis waterfall supports retry and removes listener on dispose", {
  skip: !process.env.DSH_TEST_PREFIX && "set DSH_TEST_PREFIX for official Cordis integration",
}, async t => {
  const require = createRequire(path.join(path.resolve(process.env.DSH_TEST_PREFIX), "package.json"));
  const { Context } = await import(pathToFileURL(require.resolve("@deepseek-ai/cordis")).href);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  let calls = 0;
  const dispatch = request => ctx.waterfall("llm/stream", request, () => {
    calls++;
    return stream(delta(calls === 1 ? "我不能帮助" : "parser implementation"), finish);
  });
  ctx.provide("llm", { stream: dispatch });
  const off = installRefusalRetry(ctx, { getConfig: () => ({ refusalRetry: true }) });
  const result = await collect(dispatch(options()));
  assert.equal(calls, 2);
  assert.equal(result[0].text, "parser implementation");
  off();
  calls = 0;
  assert.equal((await collect(dispatch(options())))[0].text, "我不能帮助");
  assert.equal(calls, 1);
});

test("official LlmRuntime adapter receives modified copies and retry failures preserve original output", {
  skip: !process.env.DSH_FULL_TEST_PREFIX && "set DSH_FULL_TEST_PREFIX for official LlmRuntime integration",
}, async t => {
  const require = createRequire(path.join(path.resolve(process.env.DSH_FULL_TEST_PREFIX), "package.json"));
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const [{ Context }, { LlmRuntime, LlmAdapter }] = await Promise.all([
    load("@deepseek-ai/cordis"), load("@deepseek-ai/dsh-llm"),
  ]);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  const llm = ctx.get("llm");
  const requests = [];
  let fail = false;
  class FixtureAdapter extends LlmAdapter {
    stream(request) {
      requests.push(request);
      if (requests.length % 2 === 1) return stream(delta("我不能帮助"), finish);
      if (fail) throw Object.assign(new Error("fixture disconnect"), { code: "TRANSPORT" });
      return stream(delta("parser implementation"), finish);
    }
  }
  llm.registerAdapter(["fixture"], new FixtureAdapter());
  installRefusalRetry(ctx, { getConfig: () => ({ refusalRetry: true }) });
  const request = { ...options(), provider: "fixture", model: "fixture" };
  const before = structuredClone(request);
  assert.equal((await collect(llm.stream(request)))[0].text, "parser implementation");
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages[0].content, /operator/);
  assert.deepEqual(request, before);
  fail = true;
  assert.deepEqual(await collect(llm.stream(request)), [delta("我不能帮助"), finish]);
  assert.equal(requests.length, 4);
});
