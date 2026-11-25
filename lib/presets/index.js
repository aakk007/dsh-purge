/**
 * dsh-purge 自带 agent 预设：无限制模式（unrestricted）
 *
 * 两件事：
 *   1. 首次把 `presets/unrestricted` 落到 `$DSH_HOME/.agent-presets/unrestricted/`
 *      （已有用户文件默认不覆盖，自愈式安装见 {@link installPreset}）；
 *   2. 等 `agentPresets` 就绪后注册「无限制模式」与「无限制模式（子智能体）」，
 *      卸载时逆序释放。
 *
 * 模式下拉（DSH 0.1.7+）只认 `agentPresets.register()`：把文件夹塞进
 * `.agent-presets/` 不会出现在下拉里，所以这里必须走注册表，和红队预设同一条路。
 *
 * 子智能体：随包预设里的 spawn 行仍带 0.2.2-rc.1 已删除的 `toolFilter`。
 * 注册时用 {@link prepareSubagentPresets} 在内存里把它换成独立的执行预设
 * 「无限制模式（子智能体）」——用户磁盘上的 YAML 不会被改写。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPresetDefinition } from '../redteam/preset-composition.js'
import { ensureDshGoCompat } from '../host-compat/subagent-list-agents.mjs'
import { prepareSubagentPresets, registerPresetDefinitions } from '../host-compat/subagent-presets.mjs'
import { backupPresetMigration } from '../host-compat/migration-backup.mjs'
import { adaptListAgents } from '../host-compat/preset-adapter.mjs'

/** Cordis 插件名。 */
export const name = 'dsh-purge-presets'

/** 与红队预设一致：不硬依赖 agentPresets，就绪后软取并声明。 */
export const inject = []

/** 模式下拉里的预设 id（目录名 / registry id）。 */
export const UNRESTRICTED_PRESET_ID = 'unrestricted'

/** 子智能体执行预设：编号与显示名。 */
export const UNRESTRICTED_WORKER = Object.freeze({
  workerId: 'unrestricted-worker',
  workerName: '无限制模式（子智能体）',
  workerDescription: '由无限制模式的指挥端通过 subagent 选择的执行预设，不再向下委派。',
  presetLabel: '无限制模式预设',
})

/** 随包预设里的两个文件。 */
const PRESET_FILES = ['preset.yml', 'agent.cordis.yml']

/** 插件根目录（lib/presets → 上两级）。 */
export function packagePaths() {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  return { root, presets: join(root, 'presets'), presetDir: join(root, 'presets', UNRESTRICTED_PRESET_ID) }
}

/** DSH 数据目录（与红队预设同一份约定）。 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 用户 preset 根（与 dsh-agent-presets 的 USER_PRESET_DIR 保持一致）。 */
export function userPresetRoot(home = dshHome()) {
  return join(home, '.agent-presets')
}

/** 无限制模式在用户目录里的落地位置。 */
export function userPresetDir(home = dshHome()) {
  return join(userPresetRoot(home), UNRESTRICTED_PRESET_ID)
}

/**
 * 把随包预设落到用户目录。
 *
 * 语义：目标已有 `agent.cordis.yml` 且没给 force → 保留用户内容（`kept`）；
 * force 或缺文件 → 覆盖/补齐（`updated` / `installed`）。
 * 与红队预设不同，这里没有需要自愈的本机绝对路径，所以不做正文改写。
 */
export function installPreset({ force = false, home = dshHome() } = {}) {
  const src = packagePaths().presetDir
  if (!existsSync(join(src, 'agent.cordis.yml'))) throw new Error(`发行包里没有预设：${src}`)
  const dir = userPresetDir(home)
  const exists = existsSync(join(dir, 'agent.cordis.yml'))
  if (exists && !force) return { action: 'kept', dir, files: PRESET_FILES.slice() }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const file of PRESET_FILES) {
    const from = join(src, file)
    if (!existsSync(from)) continue
    copyFileSync(from, join(dir, file))
  }
  return { action: exists ? 'updated' : 'installed', dir, files: PRESET_FILES.slice() }
}

/** 注册状态（自检/排错用），与红队预设的 preset-declare.json 分开写。 */
export function statusFile(home = dshHome()) {
  return join(home, 'dsh-purge', 'unrestricted-preset.json')
}

function writeStatus(patch, home = dshHome()) {
  try {
    const file = statusFile(home)
    mkdirSync(dirname(file), { recursive: true })
    let prev = {}
    try { prev = JSON.parse(readFileSync(file, 'utf8')) } catch { /* first */ }
    writeFileSync(file, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }, null, 2), 'utf8')
  } catch { /* ignore */ }
}

/** 用户改过就用磁盘上那份，否则用包内模板。 */
export function presetSourceDir(home = dshHome()) {
  const user = userPresetDir(home)
  if (existsSync(join(user, 'agent.cordis.yml'))) return user
  return packagePaths().presetDir
}

/**
 * 读取、迁移并注册两份预设。
 * @returns {Promise<{ ok: boolean, ids: string[], broken: string | null }>}
 */
export async function registerUnrestrictedPresets(registry, { home = dshHome(), hostCompat, installAnchor } = {}) {
  const dir = presetSourceDir(home)
  const definition = readPresetDefinition(UNRESTRICTED_PRESET_ID, dir)
  let definitions = prepareSubagentPresets(definition, UNRESTRICTED_WORKER)
  // 未知宿主版本只做社区版的能力探测：宿主主入口已经提供 list_agents 时，
  // 去掉冗余的旧入口行；不写宿主文件，也不覆盖 off / restore 的选择。
  if (hostCompat?.state === 'unsupported-version') {
    definitions = definitions.map(item => adaptListAgents(item, installAnchor))
  }
  if (JSON.stringify(definitions) !== JSON.stringify([definition])) {
    const backup = backupPresetMigration({ home, dir, id: UNRESTRICTED_PRESET_ID, definitions })
    writeStatus({ migrationBackup: backup }, home)
  }
  const release = await registerPresetDefinitions(registry, definitions)
  const ids = definitions.map(item => item.id)
  let broken = null
  try {
    const listed = await registry.list()
    broken = listed.filter(item => ids.includes(item.id) && item.broken)
      .map(item => `${item.id}: ${item.broken}`).join('\n') || null
  } catch { /* 列表接口不可用时不阻塞注册 */ }
  writeStatus({
    ok: !broken,
    phase: broken ? 'registered-broken' : 'registered',
    presetDir: dir,
    registeredPresets: ids,
    broken,
  }, home)
  return { ok: !broken, ids, broken, release, definitions, dir }
}

/**
 * @param ctx - 插件上下文。
 */
export function apply(ctx, config = {}) {
  let hostCompat
  try {
    hostCompat = ensureDshGoCompat({ mode: config.hostCompat ?? 'install' })
  } catch (error) {
    hostCompat = { state: 'failed', error: error?.message || String(error) }
  }
  const home = dshHome()
  const pluginVersion = (() => {
    try { return JSON.parse(readFileSync(join(packagePaths().root, 'package.json'), 'utf8')).version } catch { return undefined }
  })()

  let installed = { action: 'missing' }
  try {
    installed = installPreset({ force: process.env.DSH_PURGE_PRESET_REFRESH === '1', home })
  } catch (error) {
    ctx.logger?.warn?.('dsh-purge-presets: 预设落地失败：%s', error?.message || String(error))
  }
  writeStatus({ ok: false, phase: 'apply-start', pluginVersion, hostCompat, preset: installed, presetDir: installed.dir }, home)

  let releaseDeclared
  let closed = false
  const softRegistry = () => {
    try {
      if (ctx.agentPresets && typeof ctx.agentPresets.register === 'function') return ctx.agentPresets
    } catch { /* without inject */ }
    try {
      const reg = ctx.get('agentPresets')
      if (reg && typeof reg.register === 'function') return reg
    } catch { /* missing */ }
    return null
  }
  const undeclare = async () => {
    const dispose = releaseDeclared
    releaseDeclared = undefined
    if (!dispose) return
    try { await dispose() } catch (error) {
      ctx.logger?.warn?.('dsh-purge-presets: undeclare failed: %s', error?.message || String(error))
    }
  }
  const declare = async (registry) => {
    try {
      const installAnchor = (() => {
        try { return ctx.get?.('profileContext')?.installAnchor } catch { return undefined }
      })()
      const result = await registerUnrestrictedPresets(registry, { home, hostCompat, installAnchor })
      if (closed) {
        await undeclare()
        return
      }
      releaseDeclared = result.release
      if (result.broken) ctx.logger?.warn?.('dsh-purge-presets: declared but broken: %s', result.broken)
      else ctx.logger?.info?.('dsh-purge-presets: 已注册 %s', result.ids.join(' / '))
    } catch (error) {
      const message = error?.message || String(error)
      writeStatus({ ok: false, phase: 'register-failed', error: message }, home)
      ctx.logger?.warn?.('dsh-purge-presets: register failed: %s', message)
    }
  }

  ctx.effect(() => {
    let tries = 0
    let timer
    let stop
    const tick = () => {
      if (closed) return true
      tries += 1
      const registry = softRegistry()
      if (!registry) {
        writeStatus({ ok: false, phase: 'waiting-registry', tries }, home)
        return false
      }
      void declare(registry)
      return true
    }
    if (!tick()) {
      timer = setInterval(() => {
        if (tick()) {
          clearInterval(timer)
          timer = undefined
          if (stop) clearTimeout(stop)
        }
      }, 400)
      if (typeof timer.unref === 'function') timer.unref()
      stop = setTimeout(() => {
        if (timer) {
          clearInterval(timer)
          timer = undefined
          writeStatus({ ok: false, phase: 'timeout-waiting-registry', tries }, home)
        }
      }, 45000)
      try { stop.unref?.() } catch { /* ignore */ }
    }
    return () => {
      closed = true
      if (timer) clearInterval(timer)
      if (stop) clearTimeout(stop)
      void undeclare()
    }
  }, 'dsh-purge-presets: declare unrestricted preset')

  ctx.logger?.info?.('dsh-purge-presets: 就绪（预设 %s）', installed.dir || userPresetDir(home))
}

export default { name, inject, apply }
