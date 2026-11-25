import { MaintenanceStore } from './maintenance.js';

// 路径只由服务端实例注入，HTTP 请求只接受动作与备份编号。
export function maintenanceOperation({ home, root }, body) {
  const store = new MaintenanceStore({ home, root });
  if (!body) return store.status();
  if (body.op === 'backup') return { ok: true, ...store.snapshot('manual') };
  if (body.op === 'rollback') return store.restore(body.id);
  throw Object.assign(Error('未知维护操作'), { status: 400 });
}
