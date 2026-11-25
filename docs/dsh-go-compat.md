# DSH Go 1.3.0 兼容修复 / Compatibility fix

当前分支版本：`1.1.76`；本文记录 `.4` 引入并在 `.5` 保留的手机兼容修复，`1.1.74` 的“无限制模式”与 dshgo 网页版遮挡修复，`1.1.75` 对插件详情页乱码描述的修复，以及 `1.1.76` 补回的设置入口与更新按钮。原作者为 YuJunZhiXue，原包基线为 `1.1.71`。

## 设置入口、更新按钮与插件详情配置（1.1.76）

停靠面板（`shell.overlay`）是 1.1.7x 加的快捷入口，合并时把 1.1.71 原有的 `settings.section` 注册替换掉了，于是「设置」里没有 dsh-purge，插件详情页也没有配置区——社区版一直保留这两处。现在四处入口同时存在：

| 槽位 | 位置 | 内容 |
| --- | --- | --- |
| `settings.section`（id `dsh-purge`，order 40） | DSH 设置 → dsh-purge | 破甲控制面（版本通道 + 检查更新 / 立即更新）、规则集、技能库 |
| `plugins.bundle.config`（key `dsh-purge`） | 插件 → dsh-purge 详情页 | 同一页设置 |
| `plugins.row.config`（key `dsh-purge#dsh-purge`） | 插件列表行 | 同一页设置；`view: "summary"` 只回一行 `dsh-purge` |
| `shell.overlay`（id `dsh-purge-dock`） | 悬浮面板 | 清洗 / 备份与维护 / 演练台 |

更新按钮不需要新接口：`GET /dsh-purge/update` 返回当前版本、通道与可选版本，`POST /dsh-purge/update` 接受 `op: apply | switch | channel | auto`，更新完按宿主决定重载页面或重启。四个槽位名已在本机宿主客户端里核对存在；注册失败只记日志，不影响其余入口。

## 手机安装

1. 在 DSH Go 的自定义插件源中刷新本仓库的 `index.json`（任选一个能打开的地址）：

   | 地址 | 说明 |
   | --- | --- |
   | `https://raw.githubusercontent.com/aakk007/dsh-purge/master/index.json` | 原始地址，国内常被墙或限流 |
   | `https://cdn.jsdelivr.net/gh/aakk007/dsh-purge@master/index.json` | jsDelivr，国内一般可达 |
   | `https://fastly.jsdelivr.net/gh/aakk007/dsh-purge@master/index.json` | jsDelivr 备用节点 |
   | `https://gcore.jsdelivr.net/gh/aakk007/dsh-purge@master/index.json` | jsDelivr 备用节点 |
   | `https://ghproxy.net/https://raw.githubusercontent.com/aakk007/dsh-purge/master/index.json` | GitHub 代理 |

   刷新后显示「无法读取此索引」时，是**拉取失败**（网络/代理/超时），不是格式错误：格式不对会显示「此索引的格式无效」。换一个上表地址重试即可；索引格式本身已用官方 `dsh-plugin-market-index@0.2.2-rc.1` 的解析器验证。源地址里不要带 `?t=` 之类的查询串。
2. 更新 dsh-purge，确认“已安装”中的版本为 `1.1.76`。也可从本仓库对应 GitHub Release 下载完整插件包。
3. 让新版插件启动；若更新后仍在运行旧插件，停止并启动一次内置引擎。本版同时补回磁盘导出和当前进程解析，不再要求补盘后再额外启动一次。
4. 打开原来的“红队模式”预设，确认没有 `tool-subagent-list-agents ... never started` 或 `toolFilter is no longer supported`。模式列表新增的“红队执行模式（子智能体）”供指挥自动派活使用，日常仍选“红队模式”。
5. 模式列表里应同时出现“无限制模式”和“无限制模式（子智能体）”。没有的话看 `$DSH_HOME/dsh-purge/unrestricted-preset.json` 的 `phase`：`waiting-registry` 是 registry 还没起（重启内置引擎），`registered-broken` 的 `broken` 字段写着哪一行挂载失败。

## 无限制模式与 dshgo 网页版遮挡（1.1.74）

### 模式下拉里没有“无限制模式”

模式下拉只认 `agentPresets.register()`，把文件夹放进 `$DSH_HOME/.agent-presets/` 不会出现。本版新增插件条目 `dsh-purge/presets`（`lib/presets/index.js`）：

1. 首次启动把随包 `presets/unrestricted/{preset.yml,agent.cordis.yml}` 落到 `$DSH_HOME/.agent-presets/unrestricted/`；已有 `agent.cordis.yml` 时保留用户内容（要重置：`DSH_PURGE_PRESET_REFRESH=1` 启动一次）。
2. 等 registry 就绪后注册“无限制模式”；spawn 行里的旧 `toolFilter` 在内存里迁移成独立的“无限制模式（子智能体）”，用户 YAML 不改写。注册前按现有约定把原始文件备份到 `$DSH_HOME/dsh-purge/preset-migrations/`。
3. 状态写入 `$DSH_HOME/dsh-purge/unrestricted-preset.json`（`phase`、`registeredPresets`、`broken`）。

预设的人设只声明“操作者意图优先、不重复声明边界”，工具面与红队模式一致，但不含 `redteam-tools` / 锚点门，技能用宿主默认根。与红队预设一样，它不重复实现宿主平面的审批/沙箱。

### 插件面板被返回、菜单图标遮挡

dshgo 把返回、菜单按钮浮在 WebView 之上（原生绘制，DOM 的 `z-index` 抢不回来），并把几何通过 `--dsh-app-*` 变量交给页面（`dsh_web_phone.css` / `web_view_page.dart`）：`--dsh-app-inset-top` 是所有按钮下方，`--dsh-app-lead-h` 是按钮底边，`--dsh-app-status` + `--dsh-app-band` 是桌面布局的状态栏与 band，`--dsh-app-inset-{left,right,bottom}` 是安全区。

停靠面板原来固定在 `y=48` 的右上角，手机上面板几乎占满宽度，正好压在两个按钮下面。现在 `appChromeInsets()` 读这些变量，默认位置与拖动/缩放约束都从按钮下方开始，并收在安全区内；变量在页面加载后才写入时，启动阶段复核 10 秒并随布局属性变化重新收敛。官方 Web 与桌面浏览器没有这些变量，几何保持原值。授权窗、环境适配等遮挡层同样按安全区加内边距。

```sh
# 只读复核：宿主变量与面板落点（在 dshgo 页面控制台里）
getComputedStyle(document.documentElement).getPropertyValue('--dsh-app-inset-top')
document.querySelector('.dshp-dock')?.style.top
```

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

25 项本地测试通过：9 项宿主兼容测试、2 项官方市场选版测试、5 项配置迁移及生命周期测试、1 项完整宿主集成测试、4 项停靠面板几何测试、4 项无限制模式预设测试。宿主测试覆盖缺失导出、Direct 路径、清单保护、CLI 回滚、真实 Cordis Loader 和 ToolsService；官方注册器先复现 `never started`，再确认仅补盘仍失败，最后在同一进程启用解析兼容后成功注册并调用 `list_agents`。

完整集成使用隔离安装的官方 `@deepseek-ai/dsh@0.2.2-rc.1`，实际启动 Web profile（临时回环端口、关闭自动打开浏览器），先注册整份旧红队预设复现 `toolFilter` 错误，再注册迁移后的两份完整预设并检查其工具目录；同一进程随后注册“无限制模式”与“无限制模式（子智能体）”，确认两份都在 registry 列表里、`broken` 为空、执行预设不含 `subagent` / `subagent_fork` / `workflow` / `ralph`。创建空会话执行官方 `subagent` 工具，在 `startActivation` 边界捕获请求，确认 `agentPreset` 和深度参数。测试不发模型请求、不运行真实红队工作流，不替代 Android Direct/PRoot 真机测试。

```sh
DSH_TEST_PREFIX=/absolute/pristine-npm-prefix npm run test:host-compat
DSH_TEST_PREFIX=/absolute/pristine-npm-prefix node --expose-internals --test tests/host-compat.test.mjs
DSH_FULL_TEST_PREFIX=/absolute/isolated-dsh-npm-prefix npm run test:full-preset-compat
```

使用支持 `registerHooks` 的 Node（本次为 24.18.0）。前缀需包含 `@deepseek-ai/dsh-tool-subagent-control@0.2.2-rc.1`、`@deepseek-ai/dsh-agent-preset-registry@0.2.2-rc.1` 及其依赖、`@deepseek-ai/cordis-plugin-loader@1.1.0`。不设置前缀时依赖相关测试会跳过，不代表通过。

完整测试使用独立前缀中的 `@deepseek-ai/dsh@0.2.2-rc.1` 全部依赖，只修改该隔离安装的控制包清单并在 finally 中恢复。不要将完整测试指向正在使用的宿主安装。

手机验证由用户进行；本次不宣称全量红队功能或 APK 构建已验收。

## English

Refresh this fork's custom plugin index, verify installed version `1.1.76`, then start the updated plugin. Version `1.1.76` restores the settings entry and the update button: `settings.section` puts the purge panel (version channels with check/update) back under Settings → dsh-purge, and `plugins.bundle.config` / `plugins.row.config` open the same page from the plugin detail sheet and its list row; the dock stays as a shortcut. `1.1.75` restored the `package.json` description that 1.1.74 shipped double-encoded, and `1.1.74` added the unrestricted mode (two registry rows) and the dock overlay fix. Restart the embedded engine if the old plugin is still running. The mode list should show “无限制模式” and “无限制模式（子智能体）”; `$DSH_HOME/dsh-purge/unrestricted-preset.json` records the registration phase. No preset recreation or APK replacement is required.

The Web Discover page prefers stable versions. Listing the old stable `1.1.71` alongside the fix made it select the old version. The installation index now lists only the fix; the baseline remains available through its GitHub rollback tag. Regression tests run the official `0.2.2-rc.1` selection function.

The startup hook only targets the recognized Android DSH Go Linux runtime and the pinned `0.2.2-rc.1` control package. Direct guest paths are mapped through the host adapter. After restoring the disk export, a synchronous resolution hook handles stale Node exports only for the verified package directory. Other imports and installations retain normal resolution. Both preset rows remain enabled, and the main control plugin continues to own all three tools. Diagnostics record `pluginVersion`, `runtimeMode` and `liveResolution`.

The original host manifest is backed up next to `package.json`. To roll back, set `hostCompat: restore` on the `dsh-purge/redteam` plugin, restart the engine, downgrade the plugin to the retained baseline, then restart again. Alternatively use the CLI above and disable automatic repair before restarting. Downgrading alone does not revert host files. `hostCompat: off` disables future automatic writes only.

On the recognized host, legacy delegation settings are migrated in memory into an independent `redteam-worker` preset without further delegation/workflow/ralph plugins. Model selection flags are migrated; explicit modern values win. Unknown custom filters fail explicitly. User YAML files remain unchanged. The original red-team mode remains the ordinary entry point; the additional worker mode is selected automatically by spawn.

Twenty-five local tests passed, including complete official Web host startup, reproduction of the old `toolFilter` failure, registration of both red-team presets plus both unrestricted rows with no broken entries, dock-geometry checks against the host insets, and interception of an actual subagent tool's activation request to check its worker preset and depth limit. No model traffic or red-team workload is executed. Both regular and internal Loader paths were tested on Node 24.18.0. Device validation remains pending. Original authorship and licensing are retained.
