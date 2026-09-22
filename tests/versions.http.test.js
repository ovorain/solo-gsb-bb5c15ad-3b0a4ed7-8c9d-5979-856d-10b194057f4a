'use strict';
/*
 * 版本差异审阅 HTTP 测试：
 *  - 每次成功保存追加不可变快照（v1、v2…），响应带 version
 *  - 快照内容为当时方案，随后修改/再次保存不改变旧快照文件
 *  - GET /versions 列表摘要（序号升序、reason=restore、restoredFromVersion）
 *  - GET /versions/:v 完整快照；越界/不存在 → 400/404
 *  - GET /diff?from&to 以原始纸格与步骤序号为稳定身份比较
 *  - 非法保存（400）不产生新版本；删除方案连带删除版本
 *  - 列表摘要含 versions 计数
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-ver-'));
process.env.DATA_DIR = tmpData;
const app = require('../server.js');

let server, base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpData, { recursive: true, force: true });
});

async function req(method, p, body) {
  const resp = await fetch(base + p, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: resp.status, json: await resp.json() };
}
const post = (p, body) => req('POST', p, body);
const get = (p) => req('GET', p);

function plan(over = {}) {
  return {
    id: 'ver-plan', name: '版本方案', rows: 2, cols: 2, labels: {},
    steps: [], tags: [], note: '', annotations: [], ...over
  };
}

test('每次成功保存追加不可变快照，版本号递增且响应回带', async () => {
  const r1 = await post('/api/plans', plan({
    labels: { '0,0': { front: '1', back: '' } }, steps: [{ axis: 'v', line: 1, dir: 'r' }]
  }));
  assert.equal(r1.status, 200);
  assert.equal(r1.json.version, 1);

  const r2 = await post('/api/plans', plan({
    labels: { '0,0': { front: '1', back: '2' } },
    steps: [{ axis: 'v', line: 1, dir: 'r' }, { axis: 'h', line: 1, dir: 'd' }]
  }));
  assert.equal(r2.json.version, 2);

  // 快照文件落盘（6 位零填）
  const dir = path.join(tmpData, 'ver-plan.versions');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /^v\d{6}\.json$/.test(f)).sort(),
    ['v000001.json', 'v000002.json']);
});

test('旧快照不可变：再次保存后 v1 内容保持为首次方案', async () => {
  await new Promise((r) => setTimeout(r, 12));
  const v1 = await get('/api/plans/ver-plan/versions/1');
  assert.equal(v1.status, 200);
  assert.equal(v1.json.version, 1);
  assert.equal(v1.json.reason, 'save');
  assert.equal(v1.json.plan.labels['0,0'].front, '1');
  assert.equal(v1.json.plan.labels['0,0'].back, '');
  assert.equal(v1.json.plan.steps.length, 1);

  // 再保存一次（第三次）
  const r3 = await post('/api/plans', plan({
    labels: { '0,0': { front: '9', back: '9' } }, steps: []
  }));
  assert.equal(r3.json.version, 3);
  const v1Again = await get('/api/plans/ver-plan/versions/1');
  assert.equal(v1Again.json.plan.labels['0,0'].front, '1', 'v1 快照内容不被后续保存覆盖');
  assert.equal(v1Again.json.plan.steps.length, 1);
});

test('版本列表：序号升序、含摘要与最新版本号', async () => {
  const r = await get('/api/plans/ver-plan/versions');
  assert.equal(r.status, 200);
  assert.equal(r.json.latest, 3);
  assert.deepEqual(r.json.versions.map((v) => v.version), [1, 2, 3]);
  const v2 = r.json.versions[1];
  assert.equal(v2.rows, 2);
  assert.equal(v2.cols, 2);
  assert.equal(v2.steps, 2);
  assert.equal(typeof v2.savedAt, 'string');
  assert.equal(v2.reason, 'save');
  assert.equal(v2.restoredFromVersion, null);
  // 摘要不含完整 labels / steps
  assert.equal(v2.labels, undefined);
});

test('完整快照：返回当时方案全部字段（标签/备注/批注/爬移）', async () => {
  const annos = [{ id: 'anno00000x', cell: '0,0', face: 'front', severity: 'error', text: '留痕', step: 0 }];
  const r = await post('/api/plans', plan({
    note: '带批注与爬移',
    annotations: annos,
    creepCompensation: {
      params: { paperThickness: 0.1, bleed: 3 }, maxCompensation: 0.3,
      faces: { '0,0': { front: 0, back: 0, axis: 'x', creep: 0 } }
    }
  }));
  assert.equal(r.status, 200);
  const snap = await get(`/api/plans/ver-plan/versions/${r.json.version}`);
  assert.equal(snap.json.plan.note, '带批注与爬移');
  assert.equal(snap.json.plan.annotations[0].text, '留痕');
  assert.equal(snap.json.plan.creepCompensation.maxCompensation, 0.3);
});

test('恢复保存：restoredFromVersion 使新快照 reason=restore 且不覆盖来源版本', async () => {
  // 取 v1 的内容，以 restoredFromVersion=1 保存
  const v1 = await get('/api/plans/ver-plan/versions/1');
  const body = { ...v1.json.plan, id: 'ver-plan', restoredFromVersion: 1 };
  const r = await post('/api/plans', body);
  assert.equal(r.status, 200);
  const newV = r.json.version;
  assert.ok(newV > 3);
  const list = await get('/api/plans/ver-plan/versions');
  const entry = list.json.versions.find((v) => v.version === newV);
  assert.equal(entry.reason, 'restore');
  assert.equal(entry.restoredFromVersion, 1);
  // 来源 v1 内容不变
  const v1b = await get('/api/plans/ver-plan/versions/1');
  assert.equal(v1b.json.plan.labels['0,0'].front, '1');
  assert.equal(v1b.json.reason, 'save');
});

test('差异接口：页码增改 + 步骤新增 + 批注，受影响纸格并集', async () => {
  // 准备两个干净版本：A 与 B
  await post('/api/plans', {
    id: 'diff-plan', name: '差异', rows: 1, cols: 2, labels: {}, steps: [],
    tags: [], note: '',
    annotations: [{ id: 'anno00000a', cell: '0,0', face: 'front', severity: 'error', text: '旧', step: 0 }]
  });
  await post('/api/plans', {
    id: 'diff-plan', name: '差异', rows: 1, cols: 2,
    labels: { '0,0': { front: '1', back: '2' } },
    steps: [{ axis: 'v', line: 1, dir: 'r' }],
    tags: ['新标签'], note: '',
    annotations: [{ id: 'anno00000a', cell: '0,0', face: 'front', severity: 'warning', text: '旧', step: 0 }]
  });
  const r = await get('/api/plans/diff-plan/diff?from=1&to=2');
  assert.equal(r.status, 200);
  assert.equal(r.json.from.version, 1);
  assert.equal(r.json.to.version, 2);
  const { changes, summary, affectedCells } = r.json.diff;
  const kinds = new Set(changes.map((c) => c.kind));
  assert.ok(kinds.has('step'));
  assert.ok(kinds.has('label'));
  assert.ok(kinds.has('annotation'));
  assert.ok(kinds.has('meta'));
  const anno = changes.find((c) => c.kind === 'annotation');
  assert.equal(anno.op, 'change');
  assert.deepEqual(anno.fields, ['severity']);
  assert.deepEqual(affectedCells.sort(), ['0,0', '1,0']);
  assert.ok(summary.total >= 5);
});

test('差异接口：from=to、非法版本号 → 400；版本不存在 → 404', async () => {
  const same = await get('/api/plans/diff-plan/diff?from=2&to=2');
  assert.equal(same.status, 400);
  assert.equal(same.json.error.code, 'bad_version');
  const badNum = await get('/api/plans/diff-plan/diff?from=1&to=x');
  assert.equal(badNum.status, 400);
  assert.equal(badNum.json.error.code, 'bad_version');
  const missing = await get('/api/plans/diff-plan/diff?from=1&to=99');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'version_not_found');
  const snap404 = await get('/api/plans/diff-plan/versions/99');
  assert.equal(snap404.status, 404);
  const snapBad = await get('/api/plans/diff-plan/versions/0');
  assert.equal(snapBad.status, 400);
});

test('方案不存在：版本列表 / 差异 → 404；非法 id → 400', async () => {
  assert.equal((await get('/api/plans/no-such/versions')).status, 404);
  assert.equal((await get('/api/plans/no-such/diff?from=1&to=2')).status, 404);
  assert.equal((await get('/api/plans/bad%2Fid/versions')).status, 400);
});

test('非法保存（400）不产生新版本，旧版本集合不变', async () => {
  const before = (await get('/api/plans/diff-plan/versions')).json.versions.map((v) => v.version);
  const bad = await post('/api/plans', {
    id: 'diff-plan', name: '', rows: 1, cols: 2, labels: {}, steps: []
  });
  assert.equal(bad.status, 400);
  const after = (await get('/api/plans/diff-plan/versions')).json.versions.map((v) => v.version);
  assert.deepEqual(after, before);
});

test('列表摘要含 versions 计数；删除方案连带删除全部版本', async () => {
  const list = await get('/api/plans');
  const it = list.json.items.find((x) => x.id === 'diff-plan');
  assert.ok(it.versions >= 2);

  const dir = path.join(tmpData, 'diff-plan.versions');
  assert.ok(fs.existsSync(dir));
  const del = await req('DELETE', '/api/plans/diff-plan');
  assert.equal(del.status, 200);
  assert.ok(!fs.existsSync(dir), '版本目录随方案删除');
  assert.equal((await get('/api/plans/diff-plan/versions')).status, 404);
});
