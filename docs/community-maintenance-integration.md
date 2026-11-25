# 社区维护模块整合

## 来源和范围

本次从 `kingcharleslzy-ai/dsh-purge` 社区版提交
`e519253d5b01344056055af9d2041dcafa42fed3` 选择性移植维护模块，
基于本仓库 `aed39e72180c0018ae0e69d56d49eabc1123fc49`。
社区贡献及原作者 YuJunZhiXue / 小杨的 MIT 署名保留。
本次不是社区版 1.7.20 的整体升级，不替换原核心功能、提示词、技能、规则及演练台。

直接复用社区实现：

- `lib/atomic-files.js`：原子替换及文件模式保留。
- `lib/maintenance-lock.js`：跨进程互斥、存活检查、失效锁恢复。
- `lib/path-boundary.js`、`lib/remove-tree.js`：路径约束及不跟随链接的清理。
- `lib/update-integrity.js`：固定提交、完整 Git tree 和逐文件 blob 校验；
  请求函数改为显式注入，默认源改为本仓库。
- `lib/update-zip.js`：社区 ZIP 读取器的独立副本，补 Node 18 CRC32 兼容；
  原技能导入使用的 `lib/zip-extract.js` 保持不变。
- `lib/host-compat/preset-adapter.mjs`：提取社区 `adaptListAgents`，
  补 Direct 宿主路径转换。

兼容接入层为本分支实现：内容寻址插件快照、事务式文件切换、原生面板维护页、
迁移前配置备份及旧更新器对接。包名继续为 `dsh-purge`，
不引入 `dsh-purge-community` 并存安装，也不整体替换前端。
维护页使用 `npm run build:maintenance-client` 单独构建。
原演练台生成源与历史发布的嵌入代码存在差异，本次保留已发布嵌入块，
未通过原 `build:client` 重生成演练台，避免回退既有修复。

## 使用

原面板新增“备份与维护”页，显示当前安装版本、更新仓库及本安装的快照列表。
支持创建备份、刷新和选择备份后确认回滚。执行中阻止重复点击，失败显示错误并支持重试。
回滚只恢复插件文件，完成后需手动重启宿主；该入口不会应用补丁或自动重启。
源码检出目录允许备份，恢复操作必须走 Git，避免破坏分支和未提交文件。

插件备份存放在 `$DSH_HOME/dsh-purge/maintenance`：

- `objects/<sha256>` 保存去重内容；恢复前校验大小和 SHA256。
- `snapshots/<安装路径摘要>/<编号>.json` 记录该安装的文件、模式及版本。
- 回滚前创建 `before-rollback` 快照，可再次恢复到回滚前。
- 更新前创建 `before-update` 快照。
- 本轮不自动删除历史快照，备份目录按实际空间管理。

仅管理 `lib/bin/docs/presets/skills/scripts/locale` 等包内目录及明确列出的清单文件。
不备份或恢复用户 DSH_HOME 中的提示词、用户预设、数据库、会话或其他插件。
插件目录下清单范围外的文件也不会被替换。

文件切换发生异常时逆序恢复原文件；恢复异常则保留 `.maintenance-previous-*`
并报告位置。进程被强制终止不等同于可捕获异常；此时保留的快照和 previous
目录用于恢复，不宣称整目录切换具有跨进程崩溃原子性。

## 手机和配置兼容

保留原 `0.2.2-rc.1` 的 `/list-agents` 导出修复、Direct/PRoot 路径处理、
缓存解析钩子、固定 `redteam-worker`、深度限制、模型选择迁移和卸载顺序。
对原补丁判为其他版本的宿主，新增社区能力探测：仅当宿主主入口明确提供
`list_agents` 且旧入口未导出时，移除冗余的内存声明。未知、自定义声明保持原样。
该探测不写宿主文件，也不覆盖 `hostCompat: off/restore` 的选择。

迁移原预设前，将源 YAML 原始字节保存至
`$DSH_HOME/dsh-purge/preset-migrations`，记录注册的预设 ID。
重复启动复用内容相同的备份；备份损坏时报告失败，不静默接受。
新旧字段的实际转换仍使用原本已验证的手机迁移函数。

更新后迁移 profile 安装源时，先把原 `package.json` 字节保存至
`$DSH_HOME/dsh-purge/profile-migrations`；仅改本插件的依赖地址，
保留其他字段，不手改 pnpm 锁文件。包管理器后续安装负责重新解析锁文件。

## 更新与发布

旧更新器的源由历史作者仓库改为 `aakk007/dsh-purge`。
更新时先解析完整提交和 tree，然后下载固定提交归档：
校验 CRC、路径、大小、链接和所有 Git blob，完整通过后才安装。
多安装目标中后续目标失败时，回滚本次已完成的归档安装。
Git 安装仅接受本仓库 origin；脏工作区不更新，也不退回 ZIP 强行覆盖。
Git 安装阶段失败时恢复记录的原提交。

原更新器的后续宿主处理、版本通道和自动更新开关保持原有语义。
本次事务保证针对插件文件安装阶段；后续 profile 迁移或宿主处理失败，
保留备份并显示失败，不表示宿主配置已一并回滚。

本次交付为源码合并并推送，不创建 Release、不替换旧标签。
`package.json` 仍保留原发行版本；区分整合源码请以 Git 提交为准。
`index.json` 仍指向已有的 `1.1.72-dshgo.4` 发布提交；
刷新旧插件源不会自动取得本次未发版源码。
社区跟踪仓库 `aakk007/dsh-purge-kingcharleslzy-ai` 不作改动。

## 验证

新增维护测试覆盖：损坏备份、路径越界、链接、pnpm 硬链接、文件切换失败恢复、
活锁/失效锁、Direct 路径、配置字节保留、固定提交与完整性校验、真实 ZIP 安装、
多目标失败恢复，以及旧声明能力探测。
React/jsdom 测试覆盖读取失败和重试、执行状态、备份刷新、回滚确认和取消。

```sh
npm ci --ignore-scripts
npm run test:maintenance
npm run test:maintenance-ui
npm run check:maintenance-client
```

官方宿主集成沿用 `docs/dsh-go-compat.md` 中的隔离前缀约定，
必须设置前缀并检查跳过数；未设置而跳过不算通过。
本次本机使用官方 `0.2.2-rc.1` 隔离安装通过 17 项原回归，无跳过。
未对 Android 真机和生产实例执行安装或回滚。
GitHub Actions 增加 Windows/Linux、Node 18/24 的维护测试矩阵。
