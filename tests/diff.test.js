'use strict';
/*
 * 版本差异（diffPlans）单元测试：
 *  - 稳定身份：原始纸格+面别（页码）、步骤序号（折叠步骤）、批注 id
 *  - 增 / 删 / 改分类与 counts、byKind
 *  - 受影响纸格并集（页码 / 批注 / 折叠移动 / 末态几何 / 爬移）
 *  - 网格尺寸变化、标签集合（纯重排不报）、备注 / 名称
 *  - 批注解决状态与仅创建步变化的处理
 *  - 含非法折叠版本：差异仍可计算，geometryInterrupted 标明首个错误
 *  - 宽容规整：缺省字段不报错
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/foldEngine.js');

const STEPS = [
  { axis: 'v', line: 1, dir: 'r' },
  { axis: 'h', line: 1, dir: 'd' }
];
function plan(over = {}) {
  return {
    name: '差异方案', rows: 2, cols: 2, labels: {}, steps: STEPS,
    tags: [], note: '', annotations: [], ...over
  };
}
const find = (d, pred) => d.changes.filter(pred);
const one = (d, pred) => {
  const xs = find(d, pred);
  assert.equal(xs.length, 1, `期望恰好 1 条，实际 ${xs.length}`);
  return xs[0];
};

test('无变化：total=0，受影响纸格为空', () => {
  const d = E.diffPlans(plan(), plan());
  assert.equal(d.ok, true);
  assert.equal(d.summary.total, 0);
  assert.deepEqual(d.affectedCells, []);
  assert.equal(d.geometryInterrupted.from, null);
  assert.equal(d.geometryInterrupted.to, null);
});

test('页码：正面改、反面新增、整面删除均以原格+面为身份', () => {
  const d = E.diffPlans(
    plan({ labels: { '0,0': { front: '4', back: '5' }, '1,0': { front: '6', back: '3' } } }),
    plan({ labels: { '0,0': { front: '9', back: '' }, '1,0': { front: '6', back: '3' } } }));
  const ch = one(d, (c) => c.kind === 'label' && c.cell === '0,0' && c.face === 'front');
  assert.equal(ch.op, 'change');
  assert.equal(ch.from, '4');
  assert.equal(ch.to, '9');
  assert.deepEqual(ch.cells, ['0,0']);
  const rm = one(d, (c) => c.kind === 'label' && c.face === 'back' && c.cell === '0,0');
  assert.equal(rm.op, 'remove');
  assert.equal(rm.from, '5');
  assert.equal(rm.to, '');
  // 未变化的面不报
  assert.equal(find(d, (c) => c.kind === 'label' && c.cell === '1,0').length, 0);
  assert.deepEqual(d.affectedCells, ['0,0']);
});

test('页码：空白→有值为 add；新格标注结合网格条处理', () => {
  const d = E.diffPlans(
    plan({ labels: {} }),
    plan({ labels: { '0,1': { front: '', back: '2' } } }));
  const ch = one(d, (c) => c.kind === 'label' && c.cell === '0,1' && c.face === 'back');
  assert.equal(ch.op, 'add');
  assert.equal(ch.from, '');
  assert.equal(ch.to, '2');
});

test('折叠步骤：以序号为身份，新增/删除/修改均标出受影响原始纸格', () => {
  const d = E.diffPlans(
    plan({ steps: [{ axis: 'v', line: 1, dir: 'r' }] }),
    plan({ steps: [{ axis: 'v', line: 1, dir: 'r' }, { axis: 'h', line: 1, dir: 'd' }] }));
  const add = one(d, (c) => c.kind === 'step' && c.op === 'add');
  assert.equal(add.index, 1);
  assert.deepEqual(add.toCells.sort(), ['0,0', '1,0']);
  assert.deepEqual(add.fromCells, []);
  // 新增横折后 0,0/1,0 末态位置与朝向变化；所有格几何不同
  assert.ok(d.affectedCells.includes('0,0'));

  const d2 = E.diffPlans(
    plan({ steps: STEPS }),
    plan({ steps: [{ axis: 'v', line: 1, dir: 'l' }, { axis: 'h', line: 1, dir: 'd' }] }));
  const ch = one(d2, (c) => c.kind === 'step' && c.op === 'change');
  assert.equal(ch.index, 0);
  assert.equal(ch.from.dir, 'r');
  assert.equal(ch.to.dir, 'l');
});

test('折叠步骤：末步删除时该序号条目 op=remove，fromCells 为旧移动瓣', () => {
  const d = E.diffPlans(
    plan({ steps: STEPS }),
    plan({ steps: [{ axis: 'v', line: 1, dir: 'r' }] }));
  const rm = one(d, (c) => c.kind === 'step' && c.op === 'remove');
  assert.equal(rm.index, 1);
  assert.equal(rm.to, null);
  assert.ok(rm.fromText.includes('横线'));
  assert.deepEqual(rm.fromCells.sort(), ['0,0', '1,0']);
});

test('批注：以 id 匹配增删改；解决状态变化报 change；仅 step 变化不报', () => {
  const a1 = { id: 'anno000001', cell: '0,0', face: 'front', severity: 'error', text: 'a', step: 0 };
  const a2 = { id: 'anno000002', cell: '1,1', face: 'back', severity: 'info', text: 'b', step: 2 };
  const d = E.diffPlans(plan({ annotations: [a1, a2] }), plan({ annotations: [
    { ...a1, severity: 'warning' },                             // 级别修改
    { ...a2, resolved: true, step: 0 }                          // 解决；step 改了不算独立字段
  ] }));
  const cs = find(d, (c) => c.kind === 'annotation');
  assert.equal(cs.length, 2);
  const c1 = cs.find((c) => c.to.id === 'anno000001');
  assert.equal(c1.op, 'change');
  assert.deepEqual(c1.fields, ['severity']);
  const c2 = cs.find((c) => c.to.id === 'anno000002');
  assert.deepEqual(c2.fields, ['resolved']);
  assert.equal(one(d, (c) => c.kind === 'annotation' && c.op === 'change' && c.to.id === 'anno000002').op, 'change');

  const dAdd = E.diffPlans(plan({ annotations: [a1] }), plan({ annotations: [a1,
    { id: 'anno000003', cell: '0,1', face: 'back', severity: 'warning', text: 'c', step: 1 }] }));
  const add = one(dAdd, (c) => c.kind === 'annotation' && c.op === 'add');
  assert.equal(add.to.id, 'anno000003');
  assert.deepEqual(add.cells, ['0,1']);

  const dRm = E.diffPlans(plan({ annotations: [a1, a2] }), plan({ annotations: [a1] }));
  assert.equal(one(dRm, (c) => c.kind === 'annotation' && c.op === 'remove').from.id, 'anno000002');
});

test('标签 / 备注 / 名称：集合差（纯重排不报）、备注与名称修改', () => {
  const d = E.diffPlans(
    plan({ tags: ['A', 'B'], note: '旧备注', name: '旧名' }),
    plan({ tags: ['B', 'C'], note: '新备注', name: '新名' }));
  assert.equal(one(d, (c) => c.kind === 'meta' && c.field === 'tags' && c.op === 'add').tag, 'C');
  assert.equal(one(d, (c) => c.kind === 'meta' && c.field === 'tags' && c.op === 'remove').tag, 'A');
  assert.equal(one(d, (c) => c.field === 'note').op, 'change');
  assert.equal(one(d, (c) => c.field === 'name').to, '新名');

  const dReorder = E.diffPlans(plan({ tags: ['A', 'B'] }), plan({ tags: ['B', 'A'] }));
  assert.equal(find(dReorder, (c) => c.kind === 'meta').length, 0);
});

test('网格尺寸变化：grid 条给出两侧独有纸格，越界页码不重复报 label 条', () => {
  const d = E.diffPlans(
    { name: 'g', rows: 1, cols: 2, labels: { '1,0': { front: '8', back: '' } }, steps: [], tags: [], note: '', annotations: [] },
    { name: 'g', rows: 2, cols: 2, labels: { '1,0': { front: '8', back: '' } }, steps: [], tags: [], note: '', annotations: [] });
  const g = one(d, (c) => c.kind === 'grid');
  assert.deepEqual(g.from, { rows: 1, cols: 2 });
  assert.deepEqual(g.to, { rows: 2, cols: 2 });
  assert.deepEqual(g.fromCells, []);
  assert.deepEqual(g.toCells, ['0,1', '1,1']);
  // 共有格 0,0/1,0 未标注变化 → 无 label 条；新格在旧侧为 null、新侧为空白（等值）不报
  assert.equal(find(d, (c) => c.kind === 'label').length, 0);
  assert.deepEqual(d.affectedCells.sort(), ['0,1', '1,1']);
});

test('爬移补偿：新增 / 删除 / 偏移变化均报并标出纸格', () => {
  const creep = {
    params: { paperThickness: 0.1, bleed: 3 }, maxCompensation: 0.3,
    faces: {
      '0,0': { front: 0, back: 0, axis: 'x', creep: 0 },
      '1,0': { front: 0.1, back: -0.1, axis: 'x', creep: 0.1 }
    }
  };
  const d = E.diffPlans(plan(), plan({ creepCompensation: creep }));
  const c = one(d, (x) => x.kind === 'creep');
  assert.equal(c.op, 'add');
  assert.deepEqual(c.cells.sort(), ['0,0', '1,0']);

  const changed = { ...creep, faces: {
    '0,0': { front: 0, back: 0, axis: 'x', creep: 0 },
    '1,0': { front: 0.2, back: -0.2, axis: 'x', creep: 0.2 }
  } };
  const d2 = E.diffPlans(plan({ creepCompensation: creep }), plan({ creepCompensation: changed }));
  const c2 = one(d2, (x) => x.kind === 'creep');
  assert.equal(c2.op, 'change');
  assert.deepEqual(c2.changedCells, ['1,0']);
});

test('末态几何变化：仅折叠步骤改变朝向/层序时受影响原格自动并入', () => {
  // 1×2：右折与左折末态都在单叠，但各原格层序/朝向不同
  const d = E.diffPlans(
    plan({ rows: 1, cols: 2, steps: [{ axis: 'v', line: 1, dir: 'r' }] }),
    plan({ rows: 1, cols: 2, steps: [{ axis: 'v', line: 1, dir: 'l' }] }));
  one(d, (c) => c.kind === 'step');
  assert.deepEqual([...d.affectedCells].sort(), ['0,0', '1,0']);
});

test('含非法折叠版本：差异仍计算，geometryInterrupted 标明首个错误', () => {
  const bad = { axis: 'v', line: 2, dir: 'l' };   // 1×3 第二步厚度冲突
  const d = E.diffPlans(
    { name: 'x', rows: 1, cols: 3, labels: {}, steps: [{ axis: 'v', line: 1, dir: 'r' }], tags: [], note: '', annotations: [] },
    { name: 'x', rows: 1, cols: 3, labels: {}, steps: [{ axis: 'v', line: 1, dir: 'r' }, bad], tags: [], note: '', annotations: [] });
  assert.equal(d.summary.total, 1);
  assert.equal(d.geometryInterrupted.from, null);
  assert.equal(d.geometryInterrupted.to.code, 'thickness');
  assert.equal(d.geometryInterrupted.to.stepIndex, 1);
});

test('汇总统计：adds/removes/changes 与 byKind 一致；输出顺序稳定', () => {
  const d = E.diffPlans(
    plan({ labels: { '0,0': { front: '1', back: '' } }, note: 'n', tags: ['A'] }),
    plan({ labels: { '0,0': { front: '1', back: '2' }, '1,1': { front: '7', back: '' } },
      note: 'm', tags: ['B'] }));
  const kindsOrder = d.changes.map((c) => c.kind);
  const rank = { grid: 0, meta: 1, step: 2, label: 3, annotation: 4, creep: 5 };
  assert.deepEqual(kindsOrder, kindsOrder.slice().sort((a, b) => rank[a] - rank[b]),
    '按 grid→meta→step→label→annotation→creep 分段稳定输出');
  assert.equal(d.summary.byKind.meta, 3);                   // note + tag add + tag remove
  assert.ok(d.summary.byKind.label >= 2);
  assert.equal(d.summary.adds + d.summary.removes + d.summary.changes, d.summary.total);
});
