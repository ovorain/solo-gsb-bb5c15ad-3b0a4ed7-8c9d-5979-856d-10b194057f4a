#!/bin/sh
# 容器启动入口：完成依赖准备与初始化后启动服务
set -e

echo "[fold-proofing] 初始化运行环境..."

# 数据目录（方案 JSON 持久化）
mkdir -p "${DATA_DIR:-/app/data}"

# 依赖自检：缺 node_modules 时自动安装
if [ ! -d /app/node_modules ]; then
  echo "[fold-proofing] 未检测到 node_modules，执行 npm install ..."
  npm install --omit=dev --no-audit --no-fund
fi

# 引擎自检（确保折叠逻辑模块、标签/备注与校样批注规范化可加载）
node -e "
const E = require('./public/foldEngine.js');
const meta = E.normalizePlanMeta({ name: '自检', tags: [' 骑马钉 ', '骑马钉'], note: ' ok ' });
if (JSON.stringify(meta.tags) !== JSON.stringify(['骑马钉'])) throw new Error('标签规范化自检失败');
const grid = { rows: 1, cols: 2, steps: [{ axis: 'v', line: 1, dir: 'r' }] };
const annos = E.normalizeAnnotations(
  [{ cell: '0,0', face: 'front', severity: 'error', text: ' 批注自检 ', step: 1 }], grid);
if (annos.length !== 1 || annos[0].text !== '批注自检') throw new Error('批注规范化自检失败');
const loc = E.locateAnnotations(1, 2, {}, grid.steps, 1, annos);
if (!loc.ok || loc.points[0].at !== '1,0') throw new Error('批注身份定位自检失败');
// 版本差异自检：原始纸格 + 步骤序号为稳定身份，页码增改 / 步骤新增应被检出
const v1 = { name: '差异自检', rows: 1, cols: 2, labels: { '0,0': { front: '1', back: '' } }, steps: [] };
const v2 = { name: '差异自检', rows: 1, cols: 2, labels: { '0,0': { front: '1', back: '2' }, '1,0': { front: '3', back: '' } }, steps: [{ axis: 'v', line: 1, dir: 'r' }] };
const d = E.diffPlans(v1, v2);
if (!d.ok || d.summary.total < 3 || !d.affectedCells.includes('1,0')) throw new Error('版本差异计算自检失败');
console.log('[fold-proofing] 折叠引擎、标签、批注规范化与版本差异自检通过');
"

echo "[fold-proofing] 启动 Web 服务，端口 ${PORT:-3000} ..."
exec node server.js
