# DSH Go 1.3.0 兼容修复 / Compatibility fix

当前分支版本：`1.1.72-dshgo.5`；本文记录 `.4` 引入并在 `.5` 保留的手机兼容修复。`.5` 另外包含维护模块及默认关闭的 refusalRetry。原作者为 YuJunZhiXue，原包基线为 `1.1.71`。

## 手机安装

1. 在 DSH Go 的自定义插件源中刷新本仓库的 `index.json`：
   `https://raw.githubusercontent.com/aakk007/dsh-purge/master/index.json`。
2. 更新 dsh-purge，确认“已安装”中的版本为 `1.1.72-dshgo.5`。也可从本仓库对应 GitHub Release 下载完整插件包。
3. 让新版插件启动；若更新后仍在运行旧插件，停止并启动一次内置引擎。本版同时补回磁盘导出和当前进程解析，不再要求补盘后再额外启动一次。
4. 打开原来的“红队模式”预设，确认没有 `tool-subagent-list-agents ... never started` 或 `toolFilter is no longer supported`。模式列表新增的“红队执行模式（子智能体）”供指挥自动派活使用，日常仍选“红队模式”。

不需要删除或重建原预设，不需要安装新 APK。不要使用原作者 npm 包或原作者仓库的旧下载地址来获取这次修复。

发现页的选版规则优先选择稳定版：若索引同时列出旧版 `1.1.71`，会默认展示它而非 `1.1.72-dshgo.4`。当前安装索引仅列修复版，旧版通过 GitHub 回滚标签保留。2026-11-24 已使用官方 `dsh-plugin-market@0.2.2-rc.1` 的实际选版函数复现旧行为，并验证新索引默认选择修复版。

## 修改范围

仅在 Linux 且存在 DSH Go 标识 `/opt/dsh-go/dsh-go-bridge/package.json` 时，检查 `/opt/dsh/node_modules/@deepseek-ai/dsh-tool-subagent-control`。Direct 模式使用 `globalThis[Symbol.for('dsh.go.direct')].toHost` 转换这两个路径；PRoot 直接使用原路径。只接受经验证的 `0.2.2-rc.1` 清单原始／补丁后摘要，未知版本跳过，未知内容报错并不覆盖。

在该宿主包内添加 `lib/dsh-go-list-agents-compat.mjs`，恢复 `package.json` 的 `./list-agents` 导出。旧预设中的两行仍然启用；主控制插件已提供 `list_agents`，兼容入口只承担加载生命周期，避免重复注册。单独加载旧入口而不加载主控制插件，不会提供工具。

Node 已经读取旧清单时，仅写入磁盘不能刷新当前进程的 exports 缓存。本版在落盘后使用同步模块解析钩子，仅当主控制模块解析到已核验包目录时，为其 `/list-agents` 返回已写入的兼容文件。其他模块及其他安装目录继续原解析。钩子不可用时，状态标记需要重启。没有全局改写文件系统方法。

原始清单备份为 `package.json.dsh-go-list-agents-original`。不修改主控制插件实现。状态写入现有 `$DSH_HOME/redteam/preset-declare.json` 的 `hostCompat` 字段（包括 `runtimeMode`、`liveResolution`），另有 `pluginVersion`；失败原因同时记录到引擎日志。

### 子智能体旧配置

官方 `dsh-tool-subagent@0.2.2-rc.1` 明确拒绝 `toolFilter` / `persona` 配置。`.3` 修复了旧控制入口，但未覆盖整套预设，因此仍会出现用户报告的 `toolFilter` 错误。

`.4` 在宿主兼容检查返回 `installed` / `unchanged` 后，对读取的声明作内存迁移：将随包 spawn 的旧过滤配置转换为 `agentPreset: redteam-worker`，同时保留 `maxDepth: 1`。新执行预设从当前声明复制人设、技能和业务工具，去掉 subagent、workflow、ralph 等继续委派插件，保留控制和消息工具。旧 `modelSelectionSettings` 转换为新版 `modelSelection` / `modelDiscovery`，用户显式设置的新版开关优先。

用户磁盘上的预设 YAML 不因该迁移而改写；旧宿主继续读取原声明。仅自动迁移随包已知的三项 deny 配置；自定义旧过滤器或组合了旧 persona/独立预设的配置会明确报错，不静默放宽约束。两个预设按先执行端后指挥端注册，部分失败时清理，卸载时逆序释放。`preset-declare.json` 的 `registeredPresets` 记录注册项，任一个加载失败都会标记失败。

## 回滚

保留原始基线 tag `v1.1.71-before-dshgo-compat`，可重新发布旧插件。宿主补丁有独立备份，**只降级插件不会自动恢复宿主清单**。

先在 `dsh-purge/redteam` 插件的配置中设置 `hostCompat: restore` 并重启内置引擎，使插件恢复宿主清单；再安装原版插件并重启。`hostCompat: off` 仅停止自动修补，不撤销已经落盘的补丁。

也可以在内置 Linux 环境中，从当前插件安装目录执行：

```sh
node lib/host-compat/subagent-list-agents.mjs --prefix /opt/dsh --check
node lib/host-compat/subagent-list-agents.mjs --prefix /opt/dsh --restore
```

命令行恢复后，应禁用本版自动修补或降级插件，再重启，防止新版插件重新安装兼容入口。回滚保留原始备份；不存在有效备份时拒绝覆盖。

## 验证范围

17 项本地测试通过：9 项宿主兼容测试、2 项官方市场选版测试、5 项配置迁移及生命周期测试、1 项完整宿主集成测试。宿主测试覆盖缺失导出、Direct 路径、清单保护、CLI 回滚、真实 Cordis Loader 和 ToolsService；官方注册器先复现 `never started`，再确认仅补盘仍失败，最后在同一进程启用解析兼容后成功注册并调用 `list_agents`。

完整集成使用隔离安装的官方 `@deepseek-ai/dsh@0.2.2-rc.1`，实际启动 Web profile（临时回环端口、关闭自动打开浏览器），先注册整份旧红队预设复现 `toolFilter` 错误，再注册迁移后的两份完整预设并检查其工具目录。创建空会话执行官方 `subagent` 工具，在 `startActivation` 边界捕获请求，确认 `agentPreset` 和深度参数。测试不发模型请求、不运行真实红队工作流，不替代 Android Direct/PRoot 真机测试。

```sh
DSH_TEST_PREFIX=/absolute/pristine-npm-prefix npm run test:host-compat
DSH_TEST_PREFIX=/absolute/pristine-npm-prefix node --expose-internals --test tests/host-compat.test.mjs
DSH_FULL_TEST_PREFIX=/absolute/isolated-dsh-npm-prefix npm run test:full-preset-compat
```

使用支持 `registerHooks` 的 Node（本次为 24.18.0）。前缀需包含 `@deepseek-ai/dsh-tool-subagent-control@0.2.2-rc.1`、`@deepseek-ai/dsh-agent-preset-registry@0.2.2-rc.1` 及其依赖、`@deepseek-ai/cordis-plugin-loader@1.1.0`。不设置前缀时依赖相关测试会跳过，不代表通过。

完整测试使用独立前缀中的 `@deepseek-ai/dsh@0.2.2-rc.1` 全部依赖，只修改该隔离安装的控制包清单并在 finally 中恢复。不要将完整测试指向正在使用的宿主安装。

手机验证由用户进行；本次不宣称全量红队功能或 APK 构建已验收。

## English

Refresh this fork's custom plugin index, verify installed version `1.1.72-dshgo.5`, then start the updated plugin. Version `.5` retains the `.4` mobile fixes and includes maintenance modules and opt-in refusalRetry. Restart the embedded engine if the old plugin is still running. Open the existing red-team preset to verify it loads. No preset recreation or APK replacement is required.

The Web Discover page prefers stable versions. Listing the old stable `1.1.71` alongside the fix made it select the old version. The installation index now lists only the fix; the baseline remains available through its GitHub rollback tag. Regression tests run the official `0.2.2-rc.1` selection function.

The startup hook only targets the recognized Android DSH Go Linux runtime and the pinned `0.2.2-rc.1` control package. Direct guest paths are mapped through the host adapter. After restoring the disk export, a synchronous resolution hook handles stale Node exports only for the verified package directory. Other imports and installations retain normal resolution. Both preset rows remain enabled, and the main control plugin continues to own all three tools. Diagnostics record `pluginVersion`, `runtimeMode` and `liveResolution`.

The original host manifest is backed up next to `package.json`. To roll back, set `hostCompat: restore` on the `dsh-purge/redteam` plugin, restart the engine, downgrade the plugin to the retained baseline, then restart again. Alternatively use the CLI above and disable automatic repair before restarting. Downgrading alone does not revert host files. `hostCompat: off` disables future automatic writes only.

On the recognized host, legacy delegation settings are migrated in memory into an independent `redteam-worker` preset without further delegation/workflow/ralph plugins. Model selection flags are migrated; explicit modern values win. Unknown custom filters fail explicitly. User YAML files remain unchanged. The original red-team mode remains the ordinary entry point; the additional worker mode is selected automatically by spawn.

Seventeen local tests passed, including complete official Web host startup, reproduction of the old `toolFilter` failure, registration of both full presets, and interception of an actual subagent tool's activation request to check its worker preset and depth limit. No model traffic or red-team workload is executed. Both regular and internal Loader paths were tested on Node 24.18.0. Device validation remains pending. Original authorship and licensing are retained.
