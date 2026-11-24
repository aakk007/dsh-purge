# DSH Go 1.3.0 兼容修复 / Compatibility fix

本分支版本：`1.1.72-dshgo.2`。原作者为 YuJunZhiXue，原包基线为 `1.1.71`；本次仅增加宿主兼容入口和发布相关信息。

## 手机安装

1. 在 DSH Go 的自定义插件源中刷新本仓库的 `index.json`：
   `https://raw.githubusercontent.com/aakk007/dsh-purge/master/index.json`。
2. 更新 dsh-purge，确认版本为 `1.1.72-dshgo.2`。也可从本仓库对应 GitHub Release 下载完整插件包。
3. 让新版插件启动一次，再重启内置引擎。首次启动负责落盘补丁，后续重启让 Node 重新读取包导出缓存。
4. 打开原来的“红队模式”预设，确认没有 `tool-subagent-list-agents ... never started`。

不需要删除或重建原预设，不需要安装新 APK。不要使用原作者 npm 包或原作者仓库的旧下载地址来获取这次修复。

## 修改范围

仅在 Linux 且存在 DSH Go 标识 `/opt/dsh-go/dsh-go-bridge/package.json` 时，检查 `/opt/dsh/node_modules/@deepseek-ai/dsh-tool-subagent-control`。只接受经验证的 `0.2.2-rc.1` 清单原始／补丁后摘要，未知版本跳过，未知内容报错并不覆盖。

在该宿主包内添加 `lib/dsh-go-list-agents-compat.mjs`，恢复 `package.json` 的 `./list-agents` 导出。旧预设中的两行仍然启用；主控制插件已提供 `list_agents`，兼容入口只承担加载生命周期，避免重复注册。单独加载旧入口而不加载主控制插件，不会提供工具。

原始清单备份为 `package.json.dsh-go-list-agents-original`。不修改主控制插件实现。状态写入现有 `$DSH_HOME/redteam/preset-declare.json` 的 `hostCompat` 字段；失败原因同时记录到引擎日志。

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

7 项测试通过：保留原预设、真实官方包缺失导出复现、宿主识别与重复启动、未知版本／内容保护、CLI 安装与回滚、真实 Cordis Loader 在两种顺序下激活两个入口、真实 ToolsService 调用及卸载／重载生命周期。测试不运行真实红队工作流或模型请求。

```sh
DSH_TEST_PREFIX=/absolute/pristine-npm-prefix npm run test:host-compat
```

前缀需包含 `@deepseek-ai/dsh-tool-subagent-control@0.2.2-rc.1` 及其依赖、`@deepseek-ai/cordis-plugin-loader@1.1.0`。不设置前缀时依赖相关测试会跳过，不代表通过。

手机验证由用户进行；本次不宣称全量红队功能或 APK 构建已验收。

## English

Refresh this fork's custom plugin index, update to `1.1.72-dshgo.2`, let the plugin start, then restart the embedded engine once more. Open the existing red-team preset to verify it loads. No preset recreation or APK replacement is required.

The startup hook only targets the recognized Android DSH Go Linux runtime and the pinned `0.2.2-rc.1` control package. It restores the host export, retaining both existing preset rows. The main control plugin continues to own all three tools; the compatibility entry does not duplicate registration.

The original host manifest is backed up next to `package.json`. To roll back, set `hostCompat: restore` on the `dsh-purge/redteam` plugin, restart the engine, downgrade the plugin to the retained baseline, then restart again. Alternatively use the CLI above and disable automatic repair before restarting. Downgrading alone does not revert host files. `hostCompat: off` disables future automatic writes only.

Seven local tests passed using the real official package, Cordis Loader and ToolsService. Device validation remains pending. Original authorship and licensing are retained.
