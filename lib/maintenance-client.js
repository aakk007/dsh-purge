// 维护界面独立于原设置及演练台，构建时嵌入原 client.js。
export function createMaintenancePanel({ h, useState, useEffect, useRef, apiJson }) {
  return function MaintenancePanel() {
    const [state, setState] = useState(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [selected, setSelected] = useState('');
    const live = useRef(false);
    const active = useRef(false);
    const load = async () => {
      const next = await apiJson('/dsh-purge/maintenance');
      if (live.current) setState(next);
    };
    useEffect(() => {
      live.current = true;
      load().catch(e => { if (live.current) setError(e.message); });
      return () => { live.current = false; };
    }, []);
    const run = async (op, id) => {
      if (active.current) return;
      active.current = true;
      setBusy(true); setError(''); setMessage('');
      try {
        const result = op === 'refresh'
          ? await apiJson('/dsh-purge/maintenance')
          : await apiJson('/dsh-purge/maintenance', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op, id }),
          });
        if (result.ok === false) throw Error(result.error || '维护操作失败');
        if (!live.current) return;
        if (op === 'refresh') setState(result);
        else {
          setMessage(op === 'backup' ? `备份完成：${result.id}`
            : `已恢复插件文件至 ${result.version}。请手动重启宿主加载；回滚前备份：${result.backup}`);
          if (result.cleanupWarning) setError(result.cleanupWarning);
          setSelected('');
          await load();
        }
      } catch (e) { if (live.current) setError(e.message); }
      finally {
        active.current = false;
        if (live.current) setBusy(false);
      }
    };
    const button = (label, click, disabled = false) => h('button', {
      type: 'button', disabled: busy || disabled, onClick: click,
      style: { padding: '8px 12px', marginRight: 8, marginBottom: 8 },
    }, label);
    return h('section', { 'aria-label': '备份与维护', style: { padding: 16, overflowWrap: 'anywhere' } },
      h('h2', null, '备份与维护'),
      h('p', null, state ? `当前版本：${state.version} · 更新仓库：${state.repository}` : '正在读取维护状态…'),
      h('p', null, '备份插件文件，保留用户提示词、预设、数据库和其他插件配置。回滚前会自动建立新备份。'),
      state?.sourceCheckout ? h('p', null, '当前为源码工作区，可创建备份；回滚请使用 Git。') : null,
      button(busy ? '处理中…' : '创建备份', () => run('backup'), !state),
      button('刷新 / 重试', () => run('refresh')),
      busy ? h('p', { role: 'status' }, '正在执行维护，请稍候…') : null,
      message ? h('p', { role: 'status' }, message) : null,
      error ? h('p', { role: 'alert' }, error) : null,
      h('ul', { style: { paddingLeft: 20 } }, ...(state?.backups || []).map(item =>
        h('li', { key: item.id, style: { marginBottom: 16 } },
          h('div', null, `${item.version || '未知版本'} · ${item.at || item.id}`),
          item.error ? h('div', { role: 'alert' }, `备份不可用：${item.error}`)
            : h('div', null, `${item.files} 个文件 · ${(item.bytes / 1048576).toFixed(2)} MiB · ${item.reason}`),
          button('选择回滚', () => setSelected(item.id), !!item.error || state.sourceCheckout),
          selected === item.id ? h('div', null,
            h('p', null, '将恢复此备份中的插件文件，完成后需手动重启。'),
            button('确认回滚', () => run('rollback', item.id)),
            button('取消', () => setSelected('')),
          ) : null,
        ))),
      state && !state.backups.length ? h('p', null, '暂无插件备份。') : null,
    );
  };
}
