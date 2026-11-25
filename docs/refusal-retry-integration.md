# refusalRetry 集成

来源：`kingcharleslzy-ai/dsh-purge` 提交
`e519253d5b01344056055af9d2041dcafa42fed3` 的 `lib/refusal-retry.js`、
`lib/audit.js` 和三份 refusal 回归测试。原作者 YuJunZhiXue 与社区贡献者的
MIT 署名保留；仓库 `LICENSE` 不变。集成基线为本仓库 `ec1bc83`。

## 配置与行为

模块接入插件的 `llm/stream` 钩子，默认关闭。可在 `dsh-purge` 的插件配置中设置：

```yaml
refusalRetry: true
refusalSeed: true
refusalDecompose: true
```

也可将这三个字段写入 `$DSH_HOME/dsh-purge/tuning.json`；
保存文件的值优先于插件配置，每次请求读取，无需重启。
已有 tuning 文件应保留其他字段。仅布尔值 `true` 开启 `refusalRetry`。
配置损坏时打印一次诊断并透传原请求；修复文件后下一次请求恢复读取。
关闭总插件或设置 `refusalRetry: false` 即停用新请求的重试。

保留社区检测器、重试提示和阶梯：
原请求 → nudge → fiction → 可选 seed → 可选 decompose，
单次调用最多五次模型请求。seed/decompose 可以各自关闭。
它独立于既有 `autoRetry/retryMax`，后者仍管理请求错误。
所有重试重新经过宿主的 LLM 服务，因此其他插件也会收到这些请求。

首次缓冲最多到约 400 个正文字符、finish、工具调用或 16000 个推理字符；
正常流随后直接输出。长回答尾部的 partial_refused 只记录结果，不追加重试。
检测沿用社区启发式规则，语料中保留已知误判用例，不保证准确率或真实模型成功率。
重试构建或未输出前失败时返回上一轮已缓冲的输出；超过缓冲窗口的原回答
不会被完整恢复。重试已输出后断流则传播错误，避免混入前次回答。

## 本分支适配

- `lib/refusal-retry-hook.js` 只读取本模块配置，不引入其他社区 tuning 功能。
- Cordis `next()` 仅使用一次；重试通过新 `llm.stream()` 调用进入 waterfall。
  真实 Cordis 的 `next()` 不接受替换参数，因此用 WeakSet 标记请求身份，
  不向 provider 写入私有字段，也不修改被冻结的原请求。
- seed 定位最后一条 user 消息，保留图片、文件、source 和后续工具结果。
  同时支持字符串与内容块形式的系统消息。
- 取消后停止下一次请求并关闭迭代器；缓冲区中已有工具调用时透传。
- 官方宿主将 adapter 异常编码为 finish/error；重试未输出时按失败处理。
- `$DSH_HOME/dsh-purge/audit.jsonl` 记录次数、阶段、规则下标、字符数和结果；
  不记录正文开头或异常消息。日志达到 1 MiB 时轮转，保留两份旧日志。
  审计写入失败不阻断响应。结果记录在流结束后，避免提前报告 recovered。

## 验证

`npm run test:refusal-retry` 执行社区检测/流回归及本分支适配测试。
真实 Cordis 和 LlmRuntime 用例需要以下隔离宿主前缀；未配置时明确跳过。
测试只使用内存 fixture adapter，不向模型发送真实请求。

```powershell
$env:DSH_TEST_PREFIX = 'D:\Codex\workspace\.tools\dsh-compat-host'
$env:DSH_FULL_TEST_PREFIX = 'D:\Codex\workspace\.tools\dsh-full-compat'
npm run test:refusal-retry
```

全量回归还包括维护、UI、更新完整性、旧预设迁移及完整官方 Web 宿主。
市场选版测试另需 `DSH_MARKET_TEST_PREFIX` 和 `DSH_MARKET_SOURCE`。
CI 的 Windows/Linux、Node 18/24 矩阵增加 refusal 测试；
CI 未提供隔离宿主前缀时不把对应跳过项计作宿主验收。

## 回滚与交付状态

集成代码已提交为 `5e07048`，随 `1.1.72-dshgo.5` 发布；原插件源更新到 `.5`。
更新安装后默认仍关闭，已有 tuning 文件中的显式开关保持优先。
本地备份、完整 diff 和测试日志：
`D:\Codex\workspace\diagnostics\refusalRetry-20261125`。
`baseline.zip` 是修改前 `ec1bc83` 的源码归档。

回滚本次改动前先检查反向补丁能否应用；如文件已被继续修改，检查会报冲突，
应保留后续改动并逐文件处理，不强制覆盖。

```powershell
Set-Location 'D:\Codex\workspace\dsh-purge'
git apply --reverse --check 'D:\Codex\workspace\diagnostics\refusalRetry-20261125\integration.diff'
if ($LASTEXITCODE -eq 0) {
  git apply --reverse 'D:\Codex\workspace\diagnostics\refusalRetry-20261125\integration.diff'
}
```

运行时停用使用 `refusalRetry: false`；源码回滚不会删除用户设置或审计记录。
未在 Android 真机、用户运行中的宿主或真实模型上执行验收。

## English

This integrates the community refusal detector and bounded retry ladder from
commit `e519253`, with original MIT attribution retained. Enable `refusalRetry`
in plugin config or `$DSH_HOME/dsh-purge/tuning.json` (saved settings win).
It defaults off; seed and decomposition default on when retries are enabled.
There are at most four additional model calls per invocation.

The adapter uses fresh Cordis waterfalls, preserves original requests and
multimodal blocks, stops on cancellation, passes through buffered tool calls,
and handles official error finish chunks. Audit records contain metadata only.
Fallback restores the previous buffered prefix, not a complete long response.
Heuristic detection includes known false positives. Integration tests use local
fixture adapters; device and real-model effectiveness remain unverified.
Included in `1.1.72-dshgo.5`; refresh the existing plugin source to update.
Installation does not automatically enable retries or change saved settings.
