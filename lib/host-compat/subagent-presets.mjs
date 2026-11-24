const subagentPackage = '@deepseek-ai/dsh-tool-subagent';
const workerId = 'redteam-worker';
const legacyDenied = ['subagent_fork', 'workflow', 'ralph'];
const delegationPackages = new Set([
  subagentPackage,
  '@deepseek-ai/dsh-workflow-ptc',
  '@deepseek-ai/dsh-workflow-worker-thread',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-tool-ralph',
]);

function walk(rows, transform) {
  return rows.map(row => {
    if (row.group === true && Array.isArray(row.config)) {
      return { ...row, config: walk(row.config, transform) };
    }
    return transform(row);
  }).filter(Boolean);
}

/** 将随包旧 spawn 配置转换为 0.2.2-rc.1 的独立执行预设，不改用户磁盘文件。 */
export function prepareSubagentPresets(definition) {
  const commander = structuredClone(definition);
  let needsWorker = false;
  commander.plugins = walk(commander.plugins, row => {
    if (row.name !== subagentPackage || !row.config) return row;
    const config = row.config;
    if (Object.hasOwn(config, 'modelSelectionSettings')) {
      config.modelSelection ??= config.modelSelectionSettings;
      config.modelDiscovery ??= config.modelSelectionSettings;
      delete config.modelSelectionSettings;
    }
    if (!Object.hasOwn(config, 'toolFilter')) return row;
    const filter = config.toolFilter;
    const knownFilter = filter && Object.keys(filter).length === 1 &&
      Array.isArray(filter.deny) && filter.deny.length === legacyDenied.length &&
      legacyDenied.every(name => filter.deny.includes(name));
    if (config.provider !== 'spawn' || config.maxDepth !== 1 || !knownFilter ||
        config.agentPreset !== undefined || config.allowedAgentPresets !== undefined ||
        Object.hasOwn(config, 'persona')) {
      throw new Error(`红队预设 ${row.id} 含自定义旧委派配置，无法无损自动迁移；请将其工具和 persona 配置到独立 Agent Preset`);
    }
    delete config.toolFilter;
    config.agentPreset = workerId;
    needsWorker = true;
    return row;
  });
  if (!needsWorker) return [commander];

  // 原约束要求子智能体为叶子：执行预设保留业务工具、技能、消息控制和人设，
  // 去掉创建子任务的插件；maxDepth: 1 仍由指挥端传给官方 spawn。
  const worker = {
    ...structuredClone(commander),
    id: workerId,
    name: '红队执行模式（子智能体）',
    description: '由红队指挥通过 subagent 选择的执行预设，不再向下委派。',
  };
  worker.plugins = walk(worker.plugins, row => delegationPackages.has(row.name) ? null : row);
  return [worker, commander];
}

/** 注册失败时撤销已注册项；正常卸载按依赖逆序释放。 */
export async function registerPresetDefinitions(registry, definitions) {
  const releases = [];
  const dispose = async () => {
    const errors = [];
    for (const release of releases.splice(0).reverse()) {
      try { await release(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, '红队预设注销失败');
  };
  try {
    for (const definition of definitions) releases.push(await registry.register(definition));
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], '红队预设注册及清理失败'); }
    throw error;
  }
  return dispose;
}
