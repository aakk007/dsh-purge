import fs from "node:fs";
import path from "node:path";
import { streamWithRefusalRetry } from "./refusal-retry.js";

export const REFUSAL_DEFAULTS = Object.freeze({
  refusalRetry: false,
  refusalSeed: true,
  refusalDecompose: true,
});

// 仅承接本次模块的配置；不带入社区版其他 tuning 开关。
export function readRefusalSettings(home, config = {}) {
  let saved = {};
  if (home) {
    try {
      saved = JSON.parse(fs.readFileSync(path.join(home, "dsh-purge", "tuning.json"), "utf8"));
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("需要 JSON 对象");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const merged = { ...REFUSAL_DEFAULTS, ...config, ...saved };
  return {
    refusalRetry: merged.refusalRetry === true,
    refusalSeed: merged.refusalSeed !== false,
    refusalDecompose: merged.refusalDecompose !== false,
  };
}

export function installRefusalRetry(ctx, { getConfig, enabled = () => true } = {}) {
  // Cordis next() 不接受替换参数；用进程内身份记录，避免标记进入 provider。
  const retries = new WeakSet();
  let warned = false;
  return ctx.on("llm/stream", (options, next) => {
    if (options && retries.has(options)) return next();
    if (!enabled() || options?.signal?.aborted) return next();
    let config;
    try {
      config = getConfig();
      warned = false;
    } catch (error) {
      if (!warned) console.warn("[dsh-purge] refusalRetry settings unreadable:", error.code || "INVALID_SETTINGS");
      warned = true;
      return next();
    }
    if (config.refusalRetry !== true) return next();
    return streamWithRefusalRetry(() => next(), options, {
      seed: config.refusalSeed !== false,
      decompose: config.refusalDecompose !== false,
      retryStream: opts => {
        // Cordis 的 next 只能调用一次；服务按需读取，不增加启动依赖。
        const llm = ctx.reflect?.get?.("llm", false);
        if (typeof llm?.stream !== "function") return null;
        const request = { ...opts };
        retries.add(request);
        return llm.stream(request);
      },
    });
  });
}
