import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../client.js', import.meta.url));
const source = fs.readFileSync(new URL('../lib/maintenance-client.js', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace('export function createMaintenancePanel', 'function createMaintenancePanel');
const begin = '/* __DSH_PURGE_MAINTENANCE_BEGIN__ */';
const end = '/* __DSH_PURGE_MAINTENANCE_END__ */';
const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const start = text.indexOf(begin), stop = text.indexOf(end);
if (start < 0 || stop < start) throw Error('维护面板构建标记缺失');
const next = text.slice(0, start) + begin + '\n' + source +
  '\nconst MaintenancePanel = createMaintenancePanel({ h, useState, useEffect, useRef, apiJson });\n' +
  text.slice(stop);
if (process.argv.includes('--check')) {
  if (next !== text) throw Error('client.js 的维护面板未重新构建');
} else fs.writeFileSync(file, next, 'utf8');
