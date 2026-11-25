// Adapted from kingcharleslzy-ai/dsh-purge e519253 (MIT).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const CONTROL = "@deepseek-ai/dsh-tool-subagent-control";

/**
 * Resolve the host package tree. A profile anchor only sees profile plugins on
 * some layouts; the desktop host packages live under resources/app. Prefer an
 * anchor that actually contains the control package, then fall back unchanged.
 */
function hostRequire(installAnchor, target = CONTROL) {
  const direct = globalThis[Symbol.for('dsh.go.direct')];
  if (direct?.toHost) installAnchor = direct.toHost(installAnchor);
  const candidates = [installAnchor];
  const resources = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  if (resources) {
    for (const rel of ["app/dsh/node_modules", "app/node_modules"]) {
      candidates.push(path.join(resources, rel, "@deepseek-ai", target.slice("@deepseek-ai/".length), "package.json"));
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const require = createRequire(candidate);
    try {
      require.resolve(target + (target === CONTROL ? "/package.json" : ""));
      return require;
    } catch {
      // try the next anchor
    }
  }
  return null;
}

// The 0.2.2-rc.1 host moved list_agents into control.apply(). Use only the
// launching profile's dependency tree. Unknown layouts retain native errors.
export function adaptListAgents(definition, installAnchor) {
  if (!installAnchor) return definition;
  const require = hostRequire(installAnchor);
  if (!require) return definition;
  try {
    require.resolve(CONTROL + "/list-agents");
    return definition;
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") return definition;
  }
  let manifest;
  try {
    manifest = require(CONTROL + "/package.json");
  } catch (error) {
    // An opaque package is not evidence that the tool moved. Let the
    // host resolve the original composition and report its own result.
    if (["ERR_PACKAGE_PATH_NOT_EXPORTED", "MODULE_NOT_FOUND"].includes(error.code)) return definition;
    throw error;
  }
  if (manifest.name !== CONTROL) return definition;
  // Capability, not a version list: the subpath is unexported, so only remove
  // the legacy row when the control entry actually registers list_agents.
  // Future 0.2.x builds that keep the merged provider keep working, and a
  // build that stops providing it keeps the row so the host error stays visible.
  let entry;
  try {
    entry = require.resolve(CONTROL);
  } catch {
    return definition;
  }
  let source;
  try {
    source = fs.readFileSync(entry, "utf8");
  } catch {
    return definition;
  }
  if (!/registerListAgents|list_agents/.test(source)) return definition;
  const adapt = rows => {
    const control = rows.filter(row => row.name === CONTROL);
    const hasProvider = control.length === 1 && [undefined, false].includes(control[0].disabled)
      && Object.keys(control[0]).every(key => ["id", "name", "disabled"].includes(key));
    return rows.filter(row => !(hasProvider && row.name === CONTROL + "/list-agents"
      && row.id === "tool-subagent-list-agents" && [false, undefined].includes(row.disabled)
      && Object.keys(row).every(key => ["id", "name", "disabled"].includes(key))))
      .map(row => row.group === true ? { ...row, config: adapt(row.config) } : row);
  };
  return { ...definition, plugins: adapt(definition.plugins) };
}
