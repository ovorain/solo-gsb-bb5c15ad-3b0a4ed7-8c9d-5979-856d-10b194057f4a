'use strict';
/* global FoldEngine */

const E = FoldEngine;
const CELL = 88;
const PAD = 64;

// ---------- 应用状态 ----------
const app = {
  plan: {
    name: '未命名方案', rows: 0, cols: 0, labels: {}, steps: [],
    tags: [], note: '', annotations: []
  },
  upto: 0,                  // 当前回放到第几步
  replay: null,             // { state, error }
  loadedId: null,
  hitCells: [],             // 画布可点击格位
  hitHandles: [],           // 画布折叠手柄
  hoverHandle: null,
  editingCell: null,
  playTimer: null,
  imposition: { eligible: null, result: null, sig: null },  // 自动拼版状态
  pathfind: { result: null, sig: null, gridKey: null },      // 折手自动寻路状态
  track: { result: null, gridKey: null, target: null },  // 面片轨迹
  duplex: { eligible: null, open: false, flip: 'long', result: null, sig: null },  // 双面印刷版
  audit: { result: null },                  // 生产质量审计（只读，随方案变化自动重算）
  creep: { eligible: null, result: null },  // 书帖爬移补偿（实时重算，应用后写入独立字段）
  annotation: { editing: null, selectedId: null },  // 校样批注弹层 / 画布定位高亮
  listFilter: { tags: '', q: '', since: '' },   // 存档列表当前筛选条件
  // 版本差异审阅
  versions: {
    planId: null,            // 当前草稿所属存档 id
    list: null,              // 版本摘要数组（序号升序）
    diff: null,              // 当前比较结果 { fromV, toV, envelope, diff }
    review: null,             // 历史版本只读审阅：{ version, savedAt, reason, restoredFromVersion, stash }
    restoreMarker: null       // 恢复历史后首次保存携带的来源版本号（服务端快照标记 reason=restore）
  },
  diffFocus: { cells: [], step: null, annoId: null }  // 当前点击差异的聚焦信息
};

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');

// ---------- 初始化 ----------
function init() {
  $('createGridBtn').addEventListener('click', createGrid);
  document.querySelectorAll('button.fold').forEach((b) =>
    b.addEventListener('click', () => addStepFromForm(b.dataset.dir)));
  $('axisSelect').addEventListener('change', refreshLineSelect);

  $('firstBtn').addEventListener('click', () => setUpto(0));
  $('prevBtn').addEventListener('click', () => setUpto(app.upto - 1));
  $('nextBtn').addEventListener('click', () => setUpto(app.upto + 1));
  $('playBtn').addEventListener('click', togglePlay);
  $('stepSlider').addEventListener('input', (e) => setUpto(Number(e.target.value)));

  $('delStepBtn').addEventListener('click', truncateSteps);
  $('clearStepsBtn').addEventListener('click', () => {
    if (!app.plan.steps.length) return;
    app.plan.steps = [];
    setUpto(0, true);
  });

  $('saveBtn').addEventListener('click', savePlan);
  $('exportBtn').addEventListener('click', exportPlan);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', importPlan);
  $('loadListBtn').addEventListener('click', loadList);
  $('deletePlanBtn').addEventListener('click', deleteLoaded);

  // 标签编辑 / 存档列表筛选
  $('tagAddBtn').addEventListener('click', addTagFromInput);
  $('tagClearBtn').addEventListener('click', clearTags);
  $('tagInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTagFromInput(); }
  });
  $('filterApplyBtn').addEventListener('click', () => {
    app.listFilter = {
      tags: $('filterTags').value.trim(),
      q: $('filterQ').value.trim(),
      since: $('filterSince').value
    };
    loadList();
  });
  $('filterResetBtn').addEventListener('click', () => {
    $('filterTags').value = '';
    $('filterQ').value = '';
    $('filterSince').value = '';
    app.listFilter = { tags: '', q: '', since: '' };
    loadList();
  });

  $('editorCancel').addEventListener('click', () => $('cellEditor').hidden = true);
  $('editorOk').addEventListener('click', commitEditor);

  $('imposePreviewBtn').addEventListener('click', previewImposition);
  $('imposeConfirmBtn').addEventListener('click', confirmImposition);
  $('imposeCancelBtn').addEventListener('click', closeImposition);
  $('imposeStart').addEventListener('input', renderImposition);
  $('imposeCount').addEventListener('input', renderImposition);

  $('pathSearchBtn').addEventListener('click', runPathfind);

  $('trackCell').addEventListener('change', (e) => renderTrack(e.target.value, $('trackFace').value));
  $('trackFace').addEventListener('change', (e) => renderTrack($('trackCell').value, e.target.value));

  $('duplexOpenBtn').addEventListener('click', openDuplex);
  $('duplexCloseBtn').addEventListener('click', closeDuplex);
  $('duplexPrintBtn').addEventListener('click', () => window.print());
  $('duplexFlip').addEventListener('change', (e) => {
    app.duplex.flip = e.target.value;
    $('duplexFlipOverlay').value = e.target.value;
    renderDuplexPreview();
  });
  $('duplexFlipOverlay').addEventListener('change', (e) => {
    app.duplex.flip = e.target.value;
    $('duplexFlip').value = e.target.value;
    renderDuplexPreview();
  });

  $('auditExportBtn').addEventListener('click', exportAudit);

  $('creepThickness').addEventListener('input', renderCreep);
  $('creepBleed').addEventListener('input', renderCreep);
  $('creepApplyBtn').addEventListener('click', applyCreep);
  $('creepClearBtn').addEventListener('click', clearCreep);

  // 校样批注
  $('annoOpenOnly').addEventListener('change', renderAnnotations);
  $('annoSeverityFilter').addEventListener('change', renderAnnotations);
  $('annoFaceFilter').addEventListener('change', renderAnnotations);
  $('annoCancelBtn').addEventListener('click', closeAnnotationEditor);
  $('annoSaveBtn').addEventListener('click', commitAnnotation);
  $('annoDeleteBtn').addEventListener('click', deleteEditingAnnotation);
  $('annoText').addEventListener('input', () => {
    $('annoCharHint').textContent = `${[...$('annoText').value].length} / ${E.ANNO_LIMITS.MAX_TEXT_LEN}`;
  });

  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('mousemove', onCanvasMove);
  canvas.addEventListener('mouseleave', () => { app.hoverHandle = null; draw(); });

  // 版本差异审阅
  $('diffBtn').addEventListener('click', compareVersions);
  $('reviewVersionsBtn').addEventListener('click', () => {
    fillVersionSelectors(app.versions.list);
    $('versionStatus').textContent = `共 ${app.versions.list.length} 个不可变版本（按版本号升序）。`;
  });
  $('reviewExitBtn').addEventListener('click', exitReview);
  $('reviewRestoreBtn').addEventListener('click', restoreReviewedVersion);
  const syncDiffBtn = () => {
    $('diffBtn').disabled = !$('diffFrom').value || !$('diffTo').value
      || $('diffFrom').value === $('diffTo').value;
  };
  $('diffFrom').addEventListener('change', syncDiffBtn);
  $('diffTo').addEventListener('change', syncDiffBtn);
  $('planName').addEventListener('input', (e) => { app.plan.name = e.target.value; });
  $('planNote').addEventListener('input', (e) => { app.plan.note = e.target.value; });

  // 默认演示网格
  createGrid();
}

// ---------- 网格 / 方案 ----------
function createGrid() {
  if (reviewGuard('新建网格会清空当前内容。')) return;
  const rows = clampInt($('rowsInput').value, 1, 12, 2);
  const cols = clampInt($('colsInput').value, 1, 12, 2);
  app.plan = {
    name: $('planName').value || '未命名方案',
    rows, cols, labels: {}, steps: [],
    tags: [], note: '', annotations: []
  };
  app.annotation.editing = null;
  app.annotation.selectedId = null;
  $('planNote').value = '';
  renderTagChips();
  app.loadedId = null;
  resetVersionState();
  fillVersionSelectors([]);
  renderVersionCard();
  setUpto(0, true);
  refreshLineSelect();
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function refreshLineSelect() {
  const axis = $('axisSelect').value;
  const n = axis === 'v' ? app.plan.cols : app.plan.rows;
  const sel = $('lineSelect');
  sel.innerHTML = '';
  if (n < 2) {
    const o = document.createElement('option');
    o.textContent = '（该方向只有一格，无折线）';
    o.value = '';
    sel.appendChild(o);
    return;
  }
  for (let k = 1; k < n; k++) {
    const o = document.createElement('option');
    o.value = String(k);
    o.textContent = axis === 'v'
      ? `第 ${k} 条竖线（第 ${k} 与 ${k + 1} 列之间）`
      : `第 ${k} 条横线（第 ${k} 与 ${k + 1} 行之间）`;
    sel.appendChild(o);
  }
}

function addStepFromForm(dir) {
  const axis = $('axisSelect').value;
  const line = Number($('lineSelect').value);
  if (!line) {
    showFoldError({ code: 'contour', message: '当前网格该方向没有可用折线。', conflicts: [] });
    return;
  }
  const compatible = axis === 'v' ? (dir === 'l' || dir === 'r') : (dir === 'u' || dir === 'd');
  if (!compatible) {
    showFoldError({ code: 'contour', message: '折叠方向与折线不匹配：竖线只能左/右折，横线只能上/下折。', conflicts: [] });
    return;
  }
  requestStep({ axis, line, dir });
}

/**
 * 尝试追加一步：先在当前回放状态校验。
 * 若当前不在最新步，则先把回放推进到最新再校验（步骤只追加在末尾）。
 */
function requestStep(step) {
  if (reviewGuard()) return;
  // 校验基于“已应用此前所有步骤”的状态
  const base = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps).state;
  const err = E.validateFold(base, step);
  if (err) {
    showFoldError(err);
    flashConflict(err);
    return;
  }
  app.plan.steps.push(step);
  clearFoldError();
  setUpto(app.plan.steps.length, true);
}

function flashConflict(err) {
  // 冲突以“应用全部已添加步骤后”的状态为底图显示
  const state = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps).state;
  app.replay = { state, error: err };
  draw();
  renderControls();
  renderSteps();
  renderImposition();
  renderPathfind();
}

function truncateSteps() {
  if (reviewGuard()) return;
  app.plan.steps = app.plan.steps.slice(0, app.upto);
  setUpto(app.plan.steps.length, true);
}

// ---------- 回放 ----------
function setUpto(n, force) {
  const max = app.plan.steps.length;
  n = Math.max(0, Math.min(max, n));
  if (!force && n === app.upto && app.replay) return;
  app.upto = n;
  stopPlay();
  render();
}

function rerunReplay() {
  if (!app.plan.rows) { app.replay = null; return; }
  app.replay = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps, app.upto);
}

function togglePlay() {
  if (app.playTimer) { stopPlay(); return; }
  if (app.upto >= app.plan.steps.length) setUpto(0);
  $('playBtn').textContent = '⏸';
  app.playTimer = setInterval(() => {
    if (app.upto >= app.plan.steps.length) { stopPlay(); return; }
    setUpto(app.upto + 1);
  }, 800);
}
function stopPlay() {
  if (app.playTimer) clearInterval(app.playTimer);
  app.playTimer = null;
  $('playBtn').textContent = '▶';
}

// ---------- 渲染 ----------
function render() {
  rerunReplay();
  draw();
  renderSteps();
  renderSequence();
  renderControls();
  renderImposition();
  renderPathfind();
  renderTrack();
  renderDuplex();
  renderAudit();
  renderCreep();
  renderAnnotations();
  applyReviewLock();
  renderVersionCard();
}

function renderControls() {
  const max = app.plan.steps.length;
  const slider = $('stepSlider');
  slider.max = String(max);
  slider.value = String(app.upto);
  $('stepLabel').textContent = `第 ${app.upto} / ${max} 步`;
  $('delStepBtn').disabled = app.upto === 0;
  $('clearStepsBtn').disabled = max === 0;
  $('saveBtn').disabled = !app.plan.rows;
  $('prevBtn').disabled = app.upto === 0;
  $('nextBtn').disabled = app.upto >= max;
  $('canvasHint').textContent = !app.plan.rows
    ? '先在左侧创建行列纸格。'
    : app.versions.review
      ? `只读审阅 v${app.versions.review.version}：可逐步回放；紫色描边为差异受影响纸格，点击纸格可定位对应差异。`
      : '点击纸格编辑正反面页码；点击网格边缘箭头添加折叠。红色虚线手柄表示该折非法。';

  const badge = $('statusBadge');
  if (app.replay && app.replay.error) {
    badge.className = 'badge err';
    badge.textContent = '冲突：' + (app.replay.error.code === 'thickness' ? '厚度不一致' : '折线不在外轮廓');
  } else if (app.replay) {
    const info = E.pageSequence(app.replay.state);
    if (info.folded) { badge.className = 'badge ok'; badge.textContent = '已收成单叠'; }
    else { badge.className = 'badge idle'; badge.textContent = `${info.stacks.length} 个叠层`; }
  } else { badge.className = 'badge idle'; badge.textContent = ''; }

  // 只读审阅锁定：在所有卡片渲染之后再强制禁用变更控件
  applyReviewLock();
}

function renderSteps() {
  const ol = $('stepList');
  ol.innerHTML = '';
  if (!app.plan.steps.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '尚无步骤';
    ol.appendChild(li);
    return;
  }
  const dirText = { l: '◀ 向左折', r: '▶ 向右折', u: '▲ 向上折', d: '▼ 向下折' };
  // 当前审阅版本的步骤差异标记（index → op）
  const stepDiff = new Map();
  const dstate = app.versions.diff;
  if (dstate && app.versions.review) {
    const isFrom = app.versions.review.version === dstate.fromV;
    for (const ch of dstate.diff.changes) {
      if (ch.kind !== 'step') continue;
      stepDiff.set(ch.index, { op: ch.op, isFrom });
    }
  }
  // 逐步重放以标记非法步
  let st = E.initialState(app.plan.rows, app.plan.cols, app.plan.labels);
  app.plan.steps.forEach((s, i) => {
    const err = E.validateFold(st, s);
    const li = document.createElement('li');
    const pos = s.axis === 'v' ? `竖线 ${s.line}` : `横线 ${s.line}`;
    li.textContent = `${i + 1}. ${pos}，${dirText[s.dir]}`;
    if (err) {
      li.classList.add('bad');
      li.textContent += '（非法）';
    }
    if (i < app.upto && !err) li.classList.add('current');
    const df = stepDiff.get(i);
    if (df) {
      // 仅当该侧版本在此序号确有该步（新增步在旧版本不存在）才标记
      const existsOnSide = df.isFrom ? df.op !== 'add' : df.op !== 'remove';
      if (existsOnSide) li.classList.add('diff-step', df.op === 'add' ? 'diff-add' : df.op === 'remove' ? 'diff-remove' : '');
    }
    li.addEventListener('click', () => setUpto(i + 1));
    ol.appendChild(li);
    if (!err) st = E.applyFold(st, s);
  });
}

function renderSequence() {
  const box = $('sequenceBox');
  const foldState = $('foldState');
  box.innerHTML = '';
  if (!app.replay) {
    box.innerHTML = '<span class="muted">完成折叠后在此输出页码序列。</span>';
    foldState.textContent = '';
    return;
  }
  const { stacks, folded } = E.pageSequence(app.replay.state);
  stacks.forEach((grp, gi) => {
    if (stacks.length > 1) {
      const tag = document.createElement('div');
      tag.style.cssText = 'width:100%;font-size:12px;color:var(--muted)';
      tag.textContent = `叠层 @格(${grp.cell})，厚 ${grp.depth} 片`;
      box.appendChild(tag);
    }
    grp.sequence.forEach((label, i) => {
      if (i > 0) {
        const ar = document.createElement('span');
        ar.className = 'seq-arrow';
        ar.textContent = '→';
        box.appendChild(ar);
      }
      // 正立信息：封面到封底序列前半为各叶上面、后半为各叶下面
      const leafCount = grp.leaves.length;
      const leaf = grp.leaves[i < leafCount ? i : 2 * leafCount - 1 - i];
      const up = leaf && (i < leafCount ? leaf.upper.upright : leaf.lower.upright);
      const span = document.createElement('span');
      span.className = 'seq-page' + (label == null ? ' blank' : '') + (up ? '' : ' inverted');
      span.innerHTML = label == null
        ? '空白<span class="small">blank</span>'
        : escapeHtml(label) + (up ? '' : '<span class="small">⟲ 倒排</span>');
      span.title = up ? '页码正立' : '页码倒置 180°';
      box.appendChild(span);
    });
    if (gi < stacks.length - 1) {
      const gap = document.createElement('div');
      gap.style.cssText = 'width:100%;height:2px';
      box.appendChild(gap);
    }
  });
  foldState.textContent = folded
    ? '所有面片已收成单叠：上方序列即为从封面到封底的完整阅读顺序。'
    : `当前仍有 ${stacks.length} 个分离叠层，继续折叠直到单叠即可得到全书顺序。`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Canvas 绘制 ----------
function originXY(x, y) {
  return { x: PAD + x * CELL, y: PAD + y * CELL };
}

function draw() {
  app.hitCells = [];
  app.hitHandles = [];
  if (!app.plan.rows) {
    sizeCanvas(1, 1);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const w = app.plan.cols * CELL + PAD * 2;
  const h = app.plan.rows * CELL + PAD * 2;
  sizeCanvas(w, h);
  ctx.clearRect(0, 0, w, h);

  // 原始网格淡线
  ctx.save();
  ctx.strokeStyle = '#eef1f5';
  ctx.lineWidth = 1;
  for (let x = 0; x <= app.plan.cols; x++) {
    line(PAD + x * CELL, PAD, PAD + x * CELL, PAD + app.plan.rows * CELL);
  }
  for (let y = 0; y <= app.plan.rows; y++) {
    line(PAD, PAD + y * CELL, PAD + app.plan.cols * CELL, PAD + y * CELL);
  }
  ctx.restore();

  const state = app.replay ? app.replay.state : null;
  const err = app.replay ? app.replay.error : null;
  const conflicts = new Set(err ? err.conflicts : []);
  const movingCells = app.hoverHandle ? previewMoving(app.hoverHandle) : new Set();

  if (state) {
    const track = currentTrackInfo(state);
    const annoMap = currentAnnotationMarks(state);
    const diffMarks = currentDiffMarks(state);
    for (const [cellKey, ids] of Object.entries(state.stacks)) {
      const [cx, cy] = cellKey.split(',').map(Number);
      drawStack(cx, cy, ids, state, conflicts.has(cellKey), movingCells.has(cellKey),
        track && track.cell === cellKey ? track : null,
        annoMap.get(cellKey) || null,
        diffMarks && {
          origins: diffMarks.affectedOriginByCell.get(cellKey) || null,
          focus: diffMarks.focusAtNow.has(cellKey)
        });
    }
  }

  drawFoldHandles();
}

/**
 * 当前回放状态下的批注标记（以原始面片身份定位）。
 * @returns Map<当前格位key, { faces:{front:marks, back:marks}, selectedFace }>
 *   marks: [{ severity, resolved }]；任一面有批注就在该格顶部打点。
 */
function currentAnnotationMarks(state) {
  const map = new Map();
  if (!state || !Array.isArray(app.plan.annotations) || !app.plan.annotations.length) return map;
  for (const a of app.plan.annotations) {
    const p = state.panels[a.cell];
    if (!p) continue;
    const at = p.cx + ',' + p.cy;
    if (!state.stacks[at]) continue;
    let entry = map.get(at);
    if (!entry) { entry = { faces: { front: [], back: [] }, selectedFace: null }; map.set(at, entry); }
    if (entry.faces[a.face]) {
      entry.faces[a.face].push({
        severity: a.severity, resolved: a.resolved === true, id: a.id
      });
    }
    if (a.id === app.annotation.selectedId) entry.selectedFace = a.face;
  }
  return map;
}

/**
 * 当前回放状态中被追踪面片的定位信息：
 * 以原始纸格 id 为身份，在任意回放前缀（含非法步截断态）中都可找到。
 */
function currentTrackInfo(state) {
  if (!state || !app.track.target) return null;
  const id = app.track.target.cell;
  const p = state.panels[id];
  if (!p) return null;
  const cell = p.cx + ',' + p.cy;
  const ids = state.stacks[cell];
  if (!ids) return null;
  return {
    id, cell,
    layer: ids.indexOf(id) + 1,   // 1 = 最上层
    depth: ids.length,
    face: app.track.target.face,
    panel: p
  };
}

function sizeCanvas(w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.aspectRatio = `${w} / ${h}`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function line(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawStack(cx, cy, ids, state, conflict, moving, track, anno, diff) {
  const { x, y } = originXY(cx, cy);
  const depth = ids.length;
  const trackLayer = track ? track.layer : 0;   // 1 = 最上层

  // 差异受影响的原始纸格：按其在叠中的层序画紫色偏移描边（夹在层中也可见）
  const diffOriginLayers = new Map();   // layer(1基) -> 'focus'|'normal'
  if (diff && diff.origins) {
    ids.forEach((id, i) => {
      if (diff.origins.has(id)) diffOriginLayers.set(i + 1, 'normal');
    });
  }
  const diffFocus = !!(diff && diff.focus);

  // 叠层阴影面片
  for (let i = depth - 1; i >= 1; i--) {
    roundRect(x + i * 2.5, y - i * 2.5, CELL - 8, CELL - 8, 6);
    ctx.fillStyle = '#f3ecd6';
    ctx.fill();
    ctx.strokeStyle = '#d8c795';
    ctx.stroke();
  }
  // 被追踪面片若非顶层：在其偏移阴影位补一圈橙色描边（夹在叠层中可见）
  if (track && trackLayer > 1) {
    const ti = trackLayer - 1;
    roundRect(x + ti * 2.5, y - ti * 2.5, CELL - 8, CELL - 8, 6);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#e8820c';
    ctx.stroke();
  }
  // 差异面片按层描边：聚焦差异实色加粗，普通差异紫色虚线
  if (diffOriginLayers.size) {
    for (const layer of diffOriginLayers.keys()) {
      if (layer === 1) continue;   // 顶层在顶面描边处统一处理
      const li = layer - 1;
      roundRect(x + li * 2.5, y - li * 2.5, CELL - 8, CELL - 8, 6);
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#7c3aed';
      ctx.stroke();
      ctx.restore();
    }
  }

  // 顶面片
  const top = state.panels[ids[0]];
  const { side, upright } = E.visibleFace(top);
  const label = top[side];
  const isTrackTop = track && trackLayer === 1;
  const topIsDiff = diffOriginLayers.has(1);
  roundRect(x, y, CELL - 8, CELL - 8, 6);
  ctx.fillStyle = conflict ? '#fde0dd'
    : isTrackTop ? '#fff1de'
    : moving ? '#dbeafe'
    : diffFocus && topIsDiff ? '#f3e8ff'
    : topIsDiff ? '#f7f2ff' : '#fdfaf1';
  ctx.fill();
  ctx.lineWidth = conflict ? 2.5 : isTrackTop ? 2.5 : moving ? 2 : 1.2;
  ctx.strokeStyle = conflict ? '#d64545'
    : isTrackTop ? '#e8820c'
    : moving ? '#2f6fed' : '#b99e5e';
  ctx.stroke();
  // 顶层差异面片：紫色虚线外框（聚焦差异实色加粗）
  if (topIsDiff) {
    ctx.save();
    if (!diffFocus) ctx.setLineDash([5, 3]);
    ctx.lineWidth = diffFocus ? 3 : 2;
    ctx.strokeStyle = diffFocus ? '#5b21b6' : '#7c3aed';
    roundRect(x - (diffFocus ? 3 : 2), y - (diffFocus ? 3 : 2),
      CELL - 8 + (diffFocus ? 6 : 4), CELL - 8 + (diffFocus ? 6 : 4), 8);
    ctx.stroke();
    ctx.restore();
  }

  // 批注定位高亮：所选批注绑定的面片所在叠（与追踪高亮可并存），青色描边
  if (anno && anno.selectedFace) {
    ctx.save();
    ctx.setLineDash([5, 3]);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#0f9d76';
    roundRect(x - 3, y - 3, CELL - 2, CELL - 2, 8);
    ctx.stroke();
    ctx.restore();
  }

  // 页码（朝向：倒置旋转 180°）
  ctx.save();
  ctx.translate(x + (CELL - 8) / 2, y + (CELL - 8) / 2);
  if (!upright) ctx.rotate(Math.PI);
  ctx.fillStyle = '#1f2933';
  ctx.font = 'bold 26px "PingFang SC", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label === '' ? '·' : label, 0, 2);
  ctx.restore();

  // 面别与厚度徽标
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = side === 'front' ? '#2f6fed' : '#7b4ed0';
  ctx.fillText(side === 'front' ? '正面↑' : '反面↑', x + 6, y + 13);
  if (depth > 1) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#b99e5e';
    roundRect(x + CELL - 34, y + 3, 24, 15, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#8a6d2f';
    ctx.textAlign = 'center';
    ctx.fillText(`×${depth}`, x + CELL - 22, y + 14);
  }
  if (!upright) {
    ctx.fillStyle = '#d64545';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('⟲倒', x + CELL - 12, y + CELL - 13);
  }

  // 追踪面片徽标：显示其在叠中的层序（夹在层中时也可辨识）
  if (track) {
    const tag = `轨 ${track.layer}/${track.depth}`;
    ctx.font = 'bold 10px system-ui, sans-serif';
    const tw = ctx.measureText(tag).width + 10;
    roundRect(x + 4, y + CELL - 20, tw, 15, 8);
    ctx.fillStyle = '#e8820c';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag, x + 4 + tw / 2, y + CELL - 12.5);
    ctx.textBaseline = 'alphabetic';
  }

  drawAnnotationBadges(x, y, anno);

  app.hitCells.push({ x, y, w: CELL - 8, h: CELL - 8, cell: `${cx},${cy}` });
}

/**
 * 批注徽标：格顶居中并排两枚小圆点（左=正面、右=反面），
 * 颜色取该面<b>未解决</b>批注中的最高严重级别；全部已解决为带勾的绿点；
 * 数量 >1 时圆点内显示条数。该叠内任一层的原始面片批注都聚合到此格。
 */
function drawAnnotationBadges(x, y, anno) {
  if (!anno) return;
  const drawDot = (face, marks, cx) => {
    if (!marks || !marks.length) return;
    const open = marks.filter((m) => !m.resolved);
    const allResolved = open.length === 0;
    const color = allResolved ? '#2e9e5b'
      : open.some((m) => m.severity === 'error') ? '#d64545'
      : open.some((m) => m.severity === 'warning') ? '#c9810a'
      : '#0f9d76';
    ctx.beginPath();
    ctx.arc(cx, y + 8, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, y + 8, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (allResolved) {
      ctx.fillStyle = '#fff';
      ctx.fillText('✓', cx, y + 8.5);
    } else if (marks.length > 1) {
      ctx.fillStyle = '#fff';
      ctx.fillText(String(marks.length), cx, y + 8.5);
    } else {
      ctx.fillStyle = '#fff';
      ctx.fillText(face === 'front' ? '正' : '反', cx, y + 8.5);
    }
    ctx.textBaseline = 'alphabetic';
  };
  const cxm = x + (CELL - 8) / 2;
  drawDot('front', anno.faces.front, cxm - 10);
  drawDot('back', anno.faces.back, cxm + 10);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- 折叠手柄 ----------
function allPossibleSteps() {
  const out = [];
  for (let k = 1; k < app.plan.cols; k++) {
    out.push({ axis: 'v', line: k, dir: 'r' });   // 左瓣向右落
    out.push({ axis: 'v', line: k, dir: 'l' });   // 右瓣向左落
  }
  for (let k = 1; k < app.plan.rows; k++) {
    out.push({ axis: 'h', line: k, dir: 'd' });
    out.push({ axis: 'h', line: k, dir: 'u' });
  }
  return out;
}

function drawFoldHandles() {
  if (!app.replay) return;
  const baseState = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps).state;
  for (const step of allPossibleSteps()) {
    const err = E.validateFold(baseState, step);
    drawHandle(step, !!err, app.hoverHandle && app.hoverHandle.axis === step.axis
      && app.hoverHandle.line === step.line && app.hoverHandle.dir === step.dir);
  }
}

function handleRect(step) {
  const s = 18;
  const gap = 3;
  if (step.axis === 'v') {
    const gx = PAD + step.line * CELL;
    const y = 20;
    // 左按钮 ◀(dir=l)，右按钮 ▶(dir=r)，居中于网格线
    const x = step.dir === 'l' ? gx - s - gap / 2 : gx + gap / 2;
    return { x, y, w: s, h: s };
  }
  const gy = PAD + step.line * CELL;
  const x = 20;
  // 上按钮 ▲(dir=u)，下按钮 ▼(dir=d)，居中于网格线
  const y = step.dir === 'u' ? gy - s - gap / 2 : gy + gap / 2;
  return { x, y, w: s, h: s };
}

function drawHandle(step, invalid, hovered) {
  const r = handleRect(step);
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = invalid ? '#fdecea' : hovered ? '#c5d8fb' : '#eaf1fe';
  ctx.fill();
  ctx.lineWidth = hovered ? 2 : 1;
  ctx.setLineDash(invalid ? [3, 2] : []);
  ctx.strokeStyle = invalid ? '#d64545' : '#2f6fed';
  ctx.stroke();
  ctx.setLineDash([]);

  // 指示线沿网格线画一段淡色虚线（非法为红）
  if (step.axis === 'v') {
    const gx = PAD + step.line * CELL;
    ctx.strokeStyle = invalid ? 'rgba(214,69,69,.5)' : 'rgba(47,111,237,.35)';
    ctx.setLineDash([4, 4]);
    line(gx, PAD - 4, gx, PAD + app.plan.rows * CELL + 4);
    ctx.setLineDash([]);
  } else {
    const gy = PAD + step.line * CELL;
    ctx.strokeStyle = invalid ? 'rgba(214,69,69,.5)' : 'rgba(47,111,237,.35)';
    ctx.setLineDash([4, 4]);
    line(PAD - 4, gy, PAD + app.plan.cols * CELL + 4, gy);
    ctx.setLineDash([]);
  }

  // 箭头：dir 表示落向
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  ctx.fillStyle = invalid ? '#d64545' : '#2f6fed';
  ctx.beginPath();
  const t = 5;
  if (step.dir === 'r') { ctx.moveTo(cx - t, cy - t); ctx.lineTo(cx + t, cy); ctx.lineTo(cx - t, cy + t); }
  if (step.dir === 'l') { ctx.moveTo(cx + t, cy - t); ctx.lineTo(cx - t, cy); ctx.lineTo(cx + t, cy + t); }
  if (step.dir === 'd') { ctx.moveTo(cx - t, cy - t); ctx.lineTo(cx, cy + t); ctx.lineTo(cx + t, cy - t); }
  if (step.dir === 'u') { ctx.moveTo(cx - t, cy + t); ctx.lineTo(cx, cy - t); ctx.lineTo(cx + t, cy + t); }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  app.hitHandles.push({ ...r, step });
}

function previewMoving(handle) {
  const set = new Set();
  if (!app.replay) return set;
  const state = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps).state;
  const { axis, line, dir } = handle;
  const movingSide = { r: 'l', l: 'r', d: 'u', u: 'd' }[dir];
  for (const cell of Object.keys(state.stacks)) {
    const [cx, cy] = cell.split(',').map(Number);
    const side = axis === 'v' ? (cx < line ? 'l' : 'r') : (cy < line ? 'u' : 'd');
    if (side === movingSide) set.add(cell);
  }
  return set;
}

// ---------- 画布交互 ----------
function canvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return {
    x: (e.clientX - rect.left) * (canvas.width / dpr) / rect.width,
    y: (e.clientY - rect.top) * (canvas.height / dpr) / rect.height
  };
}

function hitAt(p) {
  for (const h of app.hitHandles) {
    if (p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h) return { type: 'handle', h };
  }
  for (const c of app.hitCells) {
    if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) return { type: 'cell', c };
  }
  return null;
}

function onCanvasClick(e) {
  const hit = hitAt(canvasPoint(e));
  if (!hit) return;
  if (hit.type === 'handle') requestStep(hit.h.step);
  else openEditor(hit.c.cell);
}

function onCanvasMove(e) {
  const hit = hitAt(canvasPoint(e));
  const hh = hit && hit.type === 'handle' ? hit.h.step : null;
  const changed = JSON.stringify(hh || {}) !== JSON.stringify(app.hoverHandle || {});
  app.hoverHandle = hh;
  canvas.style.cursor = hit ? 'pointer' : 'default';
  if (changed) draw();
}

// ---------- 纸格编辑器 ----------
function openEditor(cellKey) {
  if (!app.replay) return;
  if (app.versions.review) {
    // 审阅模式下点击纸格：不打开编辑弹层，改为定位差异（若该格受影响）
    focusDiffAtCell(cellKey);
    return;
  }
  const state = app.replay.state;
  const ids = state.stacks[cellKey];
  if (!ids) return;
  app.editingCell = cellKey;
  const box = $('editorRows');
  box.innerHTML = '';
  $('editorOrigin').textContent = `当前格 (${cellKey})，叠 ${ids.length} 片`;

  const wrap = document.createElement('div');
  wrap.className = 'leaves-edit';
  ids.forEach((id) => {
    const p = state.panels[id];
    const key = E.key(p.ox, p.oy);
    const cur = app.plan.labels[key] || { front: '', back: '' };
    const row = document.createElement('div');
    row.className = 'leaf-row';
    row.dataset.key = key;
    row.innerHTML = `
      <div>
        <div class="tag">原格 (${key}) · 正面页码</div>
        <input data-face="front" type="text" maxlength="8" value="${escapeHtml(cur.front || '')}" />
        <div class="face-anno-row">
          <button type="button" class="face-anno-btn" data-key="${key}" data-face="front">＋ 正面批注</button>
          <span class="face-anno-count" data-count-for="${key}|front"></span>
        </div>
      </div>
      <div>
        <div class="tag">原格 (${key}) · 反面页码</div>
        <input data-face="back" type="text" maxlength="8" value="${escapeHtml(cur.back || '')}" />
        <div class="face-anno-row">
          <button type="button" class="face-anno-btn" data-key="${key}" data-face="back">＋ 反面批注</button>
          <span class="face-anno-count" data-count-for="${key}|back"></span>
        </div>
      </div>`;
    wrap.appendChild(row);
  });
  box.appendChild(wrap);
  // 绑定批注入口：先提交页码编辑（批注基于原始面片，不依赖页码内容），再打开批注弹层
  wrap.querySelectorAll('button.face-anno-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      commitEditor();
      openAnnotationEditor(btn.dataset.key, btn.dataset.face);
    });
  });
  refreshFaceAnnoCounts(wrap);
  $('cellEditor').hidden = false;
}

/** 在页码弹层中显示每个“原格·面”的现有批注数（未解决数红色）。 */
function refreshFaceAnnoCounts(root) {
  root.querySelectorAll('[data-count-for]').forEach((el) => {
    const [key, face] = el.dataset.countFor.split('|');
    const all = (app.plan.annotations || []).filter((a) => a.cell === key && a.face === face);
    const open = all.filter((a) => !a.resolved).length;
    el.textContent = all.length ? `${open} 未解决 / ${all.length} 条` : '';
    el.classList.toggle('open', open > 0);
  });
}

function commitEditor() {
  document.querySelectorAll('#editorRows .leaf-row').forEach((row) => {
    const key = row.dataset.key;
    const front = row.querySelector('input[data-face="front"]').value.trim();
    const back = row.querySelector('input[data-face="back"]').value.trim();
    if (front || back) app.plan.labels[key] = { front, back };
    else delete app.plan.labels[key];
  });
  $('cellEditor').hidden = true;
  render();
}

// ---------- 校样批注 ----------
/** 当前方案批注（始终为数组）。 */
function annotations() {
  if (!Array.isArray(app.plan.annotations)) app.plan.annotations = [];
  return app.plan.annotations;
}

/** 当前回放下所有批注的身份定位结果（upto 变化即重算，含非法步截断态）。 */
function annotationLocations() {
  if (!app.plan.rows) return null;
  return E.locateAnnotations(
    app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps,
    app.upto, annotations());
}

const SEVERITY_NAME = { error: '严重', warning: '警告', info: '建议' };
const FACE_NAME = { front: '正面', back: '反面' };

/**
 * 打开批注编辑弹层。
 * @param targetId 编辑单个已有批注（忽略 cell/face/step）；
 *                 否则为新建，须给 cell(原始纸格)、face，step 取当前回放步。
 */
function openAnnotationEditor(cell, face, targetId) {
  if (!app.plan.rows) return;
  if (app.versions.review) {
    $('saveMsg').textContent = '历史版本为只读快照，批注不可在审阅模式下编辑。';
    return;
  }
  let rec;
  if (targetId) {
    rec = annotations().find((a) => a.id === targetId);
    if (!rec) return;
  } else {
    if (!/^\d+,\d+$/.test(cell || '')) return;
    if (face !== 'front' && face !== 'back') return;
    rec = {
      id: null, cell, face,
      severity: 'error', text: '',
      step: app.upto, resolved: false
    };
  }
  app.annotation.editing = rec.id ? { id: rec.id } : { cell: rec.cell, face: rec.face, step: rec.step };
  $('annoEditorTarget').textContent =
    `原格(${rec.cell}) · ${FACE_NAME[rec.face]}`;
  $('annoEditorMeta').textContent = targetId
    ? `编辑已有批注（创建于第 ${rec.step} 步；原格·面不可更改）`
    : `新增批注：绑定原始纸格 (${rec.cell}) 的${FACE_NAME[rec.face]}，` +
      `记录当前回放第 ${rec.step} 步；之后切换步骤或重排折叠仍会定位到该片。`;
  $('annoSeverity').value = rec.severity;
  $('annoStepText').textContent = `第 ${rec.step} / ${app.plan.steps.length} 步`;
  $('annoText').value = rec.text || '';
  $('annoCharHint').textContent = `${[...(rec.text || '')].length} / ${E.ANNO_LIMITS.MAX_TEXT_LEN}`;
  $('annoDeleteBtn').hidden = !rec.id;
  $('annoEditorMsg').hidden = true;
  $('annoEditorMsg').textContent = '';
  $('annoEditor').hidden = false;
  $('annoText').focus();
}

function closeAnnotationEditor() {
  $('annoEditor').hidden = true;
  app.annotation.editing = null;
}

function showAnnoEditorError(msg) {
  const box = $('annoEditorMsg');
  box.hidden = false;
  box.textContent = msg;
}

/** 保存（新建或编辑）批注：在前端按保存路径的同一套严格规则预校验。 */
function commitAnnotation() {
  const editing = app.annotation.editing;
  if (!editing) return;
  const existing = editing.id ? annotations().find((a) => a.id === editing.id) : null;
  const draft = {
    id: existing ? existing.id : undefined,
    cell: existing ? existing.cell : editing.cell,
    face: existing ? existing.face : editing.face,
    severity: $('annoSeverity').value,
    text: $('annoText').value,
    step: existing ? existing.step : editing.step,
    resolved: existing ? existing.resolved : false,
    createdAt: existing ? existing.createdAt : undefined,
    resolvedAt: existing ? existing.resolvedAt : undefined
  };
  let normalized;
  try {
    [normalized] = E.normalizeAnnotations([draft], {
      rows: app.plan.rows, cols: app.plan.cols, steps: app.plan.steps
    });
  } catch (e) {
    showAnnoEditorError(e.message);
    return;
  }
  if (existing) {
    const idx = annotations().findIndex((a) => a.id === existing.id);
    // 保留原创建时间；正文/级别更新后若此前已解决则自动恢复为未解决
    normalized.id = existing.id;
    normalized.createdAt = existing.createdAt;
    normalized.resolved = existing.resolved;
    normalized.resolvedAt = existing.resolvedAt;
    if (existing.resolved &&
        (existing.text !== normalized.text || existing.severity !== normalized.severity)) {
      normalized.resolved = false;
      normalized.resolvedAt = undefined;
    }
    annotations()[idx] = normalized;
    app.annotation.selectedId = normalized.id;
  } else {
    annotations().push(normalized);
    app.annotation.selectedId = normalized.id;
  }
  closeAnnotationEditor();
  render();
  $('saveMsg').textContent = existing ? '批注已更新，记得保存方案。' : '批注已添加，记得保存方案。';
}

function deleteEditingAnnotation() {
  const editing = app.annotation.editing;
  if (!editing || !editing.id) return;
  const before = annotations().length;
  app.plan.annotations = annotations().filter((a) => a.id !== editing.id);
  if (app.annotation.selectedId === editing.id) app.annotation.selectedId = null;
  closeAnnotationEditor();
  render();
  if (app.plan.annotations.length !== before) {
    $('saveMsg').textContent = '批注已删除，记得保存方案。';
  }
}

/** 解决 / 恢复单条批注。 */
function setAnnotationResolved(id, resolved) {
  const rec = annotations().find((a) => a.id === id);
  if (!rec) return;
  rec.resolved = !!resolved;
  if (resolved) rec.resolvedAt = new Date().toISOString();
  else delete rec.resolvedAt;
  app.annotation.selectedId = id;
  render();
}

/** 删除单条批注（列表内）。 */
function deleteAnnotation(id) {
  if (!annotations().some((a) => a.id === id)) return;
  if (!confirm('确定删除该条批注？')) return;
  app.plan.annotations = annotations().filter((a) => a.id !== id);
  if (app.annotation.selectedId === id) app.annotation.selectedId = null;
  render();
  $('saveMsg').textContent = '批注已删除，记得保存方案。';
}

/** 点击列表条目：定位到批注创建步并高亮其面片。 */
function locateAnnotation(id) {
  const rec = annotations().find((a) => a.id === id);
  if (!rec) return;
  app.annotation.selectedId = id;
  setUpto(Math.min(rec.step, app.plan.steps.length), true);
}

/**
 * 渲染批注卡片：统计、筛选与列表。
 * 定位信息由当前回放状态实时给出（upto/折叠重排后自动更新）。
 */
function renderAnnotations() {
  const status = $('annoStatus');
  const list = $('annoList');
  list.innerHTML = '';
  if (!app.plan.rows) {
    status.textContent = '先在左侧创建行列纸格。';
    list.innerHTML = '<li class="anno-empty">尚无批注。</li>';
    draw();
    return;
  }

  const all = annotations();
  const loc = annotationLocations();
  const atById = new Map((loc ? loc.points : []).map((p) => [p.id, p]));
  const stats = E.annotationStats(all);
  const sevText = `严重 ${stats.bySeverity.error.open} · 警告 ${stats.bySeverity.warning.open} · 建议 ${stats.bySeverity.info.open}`;
  status.textContent = all.length
    ? `共 ${stats.total} 条批注：未解决 ${stats.open}（${sevText}），已解决 ${stats.resolved}。` +
      (loc && loc.interrupted ? ' 当前回放在非法步截断，标记按截断前状态定位。' : '')
    : '尚无批注：点击画布格位 → “＋ 正面/反面批注”即可添加。';

  const openOnly = $('annoOpenOnly').checked;
  const sevFilter = $('annoSeverityFilter').value;
  const faceFilter = $('annoFaceFilter').value;

  let visible = all
    .filter((a) => !openOnly || !a.resolved)
    .filter((a) => !sevFilter || a.severity === sevFilter)
    .filter((a) => !faceFilter || a.face === faceFilter);
  // 未解决在前（同级按创建顺序 = 数组顺序）
  visible = visible.slice().sort((a, b) => Number(a.resolved) - Number(b.resolved));

  if (!all.length) {
    list.innerHTML = '<li class="anno-empty">尚无批注。</li>';
  } else if (!visible.length) {
    list.innerHTML = '<li class="anno-empty">当前筛选条件下没有批注。</li>';
  } else {
    visible.forEach((a) => list.appendChild(renderAnnotationItem(a, atById.get(a.id))));
  }
  draw();
}

function renderAnnotationItem(a, at) {
  const li = document.createElement('li');
  li.className = 'anno-item sev-' + a.severity + (a.resolved ? ' resolved' : '');

  const head = document.createElement('div');
  head.className = 'anno-head';
  const sev = document.createElement('span');
  sev.className = 'anno-sev ' + a.severity;
  sev.textContent = SEVERITY_NAME[a.severity] || a.severity;
  const target = document.createElement('span');
  target.className = 'anno-target';
  target.textContent = `原格(${a.cell})`;
  const face = document.createElement('span');
  face.className = 'anno-face ' + a.face;
  face.textContent = FACE_NAME[a.face];
  const where = document.createElement('span');
  where.className = 'anno-at';
  where.textContent = at
    ? `第 ${app.upto} 步位于格(${at.at}) · 层 ${at.layer}/${at.depth}` +
      (at.faceUp ? ' · 该面朝上' : ' · 该面朝下')
    : '当前回放步不可定位';
  head.append(sev, target, face, where);
  if (a.resolved) {
    const done = document.createElement('span');
    done.className = 'anno-resolved-tag';
    done.textContent = '✓ 已解决' + (a.resolvedAt ? ' ' + new Date(a.resolvedAt).toLocaleString() : '');
    head.appendChild(done);
  }
  li.appendChild(head);

  const text = document.createElement('div');
  text.className = 'anno-text';
  text.textContent = a.text;
  li.appendChild(text);

  const meta = document.createElement('div');
  meta.className = 'anno-meta';
  meta.textContent = `批注于第 ${a.step} 步创建` +
    (a.createdAt ? ` · ${new Date(a.createdAt).toLocaleString()}` : '');
  li.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'anno-actions';
  const jumpBtn = document.createElement('button');
  jumpBtn.type = 'button';
  jumpBtn.textContent = '定位到面片';
  jumpBtn.title = `跳转到批注创建时的第 ${a.step} 步并高亮该片`;
  jumpBtn.addEventListener('click', () => locateAnnotation(a.id));

  const resolveBtn = document.createElement('button');
  resolveBtn.type = 'button';
  resolveBtn.className = 'primary';
  if (a.resolved) {
    resolveBtn.textContent = '恢复为未解决';
    resolveBtn.classList.remove('primary');
  } else {
    resolveBtn.textContent = '标记已解决';
  }
  resolveBtn.addEventListener('click', () => setAnnotationResolved(a.id, !a.resolved));

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.textContent = '编辑';
  editBtn.addEventListener('click', () => openAnnotationEditor(null, null, a.id));

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'danger';
  delBtn.textContent = '删除';
  delBtn.addEventListener('click', () => deleteAnnotation(a.id));

  actions.append(jumpBtn, resolveBtn, editBtn, delBtn);
  li.appendChild(actions);
  return li;
}

// ---------- 自动拼版 ----------
/** 方案几何签名：网格、标注或折叠步骤变化后旧预览即失效（回放到不同步不影响）。 */
function planSignature() {
  return JSON.stringify({
    r: app.plan.rows, c: app.plan.cols,
    l: app.plan.labels, s: app.plan.steps
  });
}

function readImposeInputs() {
  return { start: Number($('imposeStart').value), count: Number($('imposeCount').value) };
}

/** 渲染拼版卡片：可用状态、禁用原因、预览内容。 */
function renderImposition() {
  if (!app.plan.rows) {
    app.imposition.eligible = null;
    $('imposePreviewBtn').disabled = true;
    $('imposeStatus').textContent = '先在左侧创建行列纸格并完成折叠。';
    $('imposeStatus').className = 'hint';
    $('imposePreview').hidden = true;
    app.imposition.result = null;
    return;
  }
  const elig = E.impositionEligibility(
    app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps);
  app.imposition.eligible = elig;

  const countInput = $('imposeCount');
  if (elig.ok) {
    countInput.max = String(elig.capacity);
    if (!countInput.placeholder) countInput.placeholder = String(elig.capacity);
    $('imposePreviewBtn').disabled = false;
    $('imposeStatus').textContent = `可拼版：容量 ${elig.capacity} 面（${app.plan.rows}×${app.plan.cols} 格 × 正反 2 面）。`;
    $('imposeStatus').className = 'hint impose-status-ok';
  } else {
    countInput.removeAttribute('max');
    $('imposePreviewBtn').disabled = true;
    const why = elig.code === 'not_single_stack'
      ? `未收成单叠：${elig.message}`
      : `禁用生成：${elig.message}`;
    $('imposeStatus').textContent = why;
    $('imposeStatus').className = 'hint impose-status-err';
    closeImposition();
    return;
  }

  // 旧预览的方案已被改动 → 作废
  if (app.imposition.result && app.imposition.sig !== planSignature()) {
    closeImposition();
  }
  if (app.imposition.result) renderImpositionPreview(app.imposition.result);
}

function closeImposition() {
  app.imposition.result = null;
  app.imposition.sig = null;
  $('imposePreview').hidden = true;
}

/** 点击“生成预览”：仅计算并展示，绝不直接改写当前标注。 */
function previewImposition() {
  if (reviewGuard()) return;
  const { start, count } = readImposeInputs();
  const result = E.autoImpose(
    app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps, start, count);
  if (!result.ok) {
    closeImposition();
    $('imposeStatus').textContent = '禁用生成：' + result.message;
    $('imposeStatus').className = 'hint impose-status-err';
    return;
  }
  app.imposition.result = result;
  app.imposition.sig = planSignature();
  $('imposePreview').hidden = false;
  renderImpositionPreview(result);
}

function faceText(face) {
  return face === 'front'
    ? '<span class="imp-face-front">正面</span>'
    : '<span class="imp-face-back">反面</span>';
}

function renderImpositionPreview(result) {
  // 摘要
  const blankNote = result.blankTrailing > 0
    ? `；末尾 ${result.blankTrailing} 个槽位为空白（已标明所属纸格与面）`
    : '';
  $('imposeSummary').innerHTML =
    `将向封面→封底共 <b>${result.capacity}</b> 个阅读槽位填入页码 ` +
    `<b>${result.startPage}–${result.startPage + result.pageCount - 1}</b>` +
    `（${result.pageCount} 页）${blankNote}。预览不会改动当前标注，确认后才批量写入。`;

  // 覆盖汇总（现有标注非空时）
  const overwrites = E.impositionOverwrite(app.plan.labels, result);
  const ovBox = $('imposeOverwrite');
  if (overwrites.length) {
    ovBox.hidden = false;
    const faceName = { front: '正面', back: '反面' };
    const lines = overwrites.map((o) => {
      const target = o.blanked ? '<b>空白</b>' : `“${escapeHtml(o.to)}”`;
      return `格(${o.cell}) ${faceName[o.face]}：“${escapeHtml(o.from)}” → ${target}`;
    });
    ovBox.innerHTML = `⚠ 确认后将覆盖 ${overwrites.length} 处现有标注：<br>${lines.join('<br>')}`;
  } else {
    ovBox.hidden = true;
    ovBox.textContent = '';
  }

  // 槽位表
  const tbody = $('imposeRows');
  tbody.innerHTML = '';
  result.slots.forEach((s, i) => {
    const tr = document.createElement('tr');
    if (s.blank) tr.className = 'blank-slot';
    if (i === 0) tr.classList.add('slot-cover');
    if (i === result.slots.length - 1) tr.classList.add('slot-backcover');
    const posName = i === 0 ? '槽 1（封面）'
      : i === result.slots.length - 1 ? `槽 ${i + 1}（封底）`
      : `槽 ${i + 1}`;
    const pageCell = s.blank
      ? '<span class="muted">空白</span>'
      : `<span class="imp-page">${escapeHtml(s.page)}</span>`;
    const upright = s.upright
      ? '正立'
      : '<span class="imp-inv" title="页码倒置 180°">⟲ 倒排</span>';
    tr.innerHTML =
      `<td>${posName}</td>` +
      `<td>${pageCell}</td>` +
      `<td>格(${s.origin}) · ${faceText(s.face)}</td>` +
      `<td>${upright}</td>`;
    tbody.appendChild(tr);
  });
}

/** 用户确认后批量写入（仅在此刻改写 labels）。 */
function confirmImposition() {
  const result = app.imposition.result;
  if (!result || app.imposition.sig !== planSignature()) return;
  const overwrites = E.impositionOverwrite(app.plan.labels, result);
  if (overwrites.length) {
    const faceName = { front: '正面', back: '反面' };
    const detail = overwrites.map((o) =>
      `格(${o.cell}) ${faceName[o.face]} “${o.from}”→${o.blanked ? '空白' : '“' + o.to + '”'}`).join('\n');
    if (!confirm(`以下 ${overwrites.length} 处现有标注将被覆盖：\n${detail}\n\n确认写入自动拼版页码？`)) return;
  }
  app.plan.labels = JSON.parse(JSON.stringify(result.labels));
  closeImposition();
  setUpto(app.upto, true);
  $('saveMsg').textContent =
    `已按自动拼版写入 ${result.pageCount} 个页码（${result.blankTrailing} 个尾部槽位留空），记得保存方案。`;
}

// ---------- 折手自动寻路 ----------
/**
 * 寻路基于“方案全部步骤回放”的末态；只要方案几何（网格/标注/步骤）变化，
 * 旧结果即作废。寻路起点与回放到第几步（upto）无关。
 */
function pathfindSignature() {
  return JSON.stringify({
    r: app.plan.rows, c: app.plan.cols,
    l: app.plan.labels, s: app.plan.steps
  });
}

/** 重建“封面原格”下拉（仅在网格尺寸变化时重建，保留用户选择）。 */
function refreshPathCells() {
  const key = `${app.plan.rows}x${app.plan.cols}`;
  if (app.pathfind.gridKey === key) return;
  app.pathfind.gridKey = key;
  const sel = $('pathCell');
  const prev = sel.value;
  sel.innerHTML = '';
  if (!app.plan.rows) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '（先创建网格）';
    sel.appendChild(o);
    return;
  }
  for (let y = 0; y < app.plan.rows; y++) {
    for (let x = 0; x < app.plan.cols; x++) {
      const id = `${x},${y}`;
      const lab = app.plan.labels[id] || {};
      const f = lab.front || '', b = lab.back || '';
      const o = document.createElement('option');
      o.value = id;
      o.textContent = `原格(${id})` + (f || b ? `  正:${f || '空'} / 反:${b || '空'}` : '');
      sel.appendChild(o);
    }
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function renderPathfind() {
  refreshPathCells();
  const btn = $('pathSearchBtn');
  const status = $('pathStatus');
  if (!app.plan.rows) {
    btn.disabled = true;
    status.className = 'hint';
    status.textContent = '先在左侧创建行列纸格。';
    $('pathResults').hidden = true;
    app.pathfind.result = null;
    return;
  }
  if (app.plan.rows > 4 || app.plan.cols > 4) {
    btn.disabled = true;
    status.className = 'hint path-status-err';
    status.textContent = `自动寻路仅支持不超过 4×4 的网格（当前为 ${app.plan.rows}×${app.plan.cols}）。`;
    $('pathResults').hidden = true;
    app.pathfind.result = null;
    return;
  }
  // 末态合法性：当前方案全部步骤必须可回放
  const full = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps);
  if (full.error) {
    btn.disabled = true;
    status.className = 'hint path-status-err';
    status.textContent = `当前方案第 ${full.error.stepIndex + 1} 步非法（${
      full.error.code === 'thickness' ? '厚度不一致' : '折线不在外轮廓'}），请先修正后再寻路。`;
    $('pathResults').hidden = true;
    app.pathfind.result = null;
    return;
  }
  btn.disabled = false;
  if (!app.pathfind.result) {
    status.className = 'hint';
    status.textContent = '从当前方案全部步骤的末态开始搜索；搜索不会改动当前步骤。';
    $('pathResults').hidden = true;
  } else if (app.pathfind.sig !== pathfindSignature() || app.pathfind.target !== `${$('pathCell').value}|${$('pathFace').value}`) {
    // 方案或目标变化后旧结果作废
    app.pathfind.result = null;
    renderPathfind();
    return;
  } else {
    renderPathResults(app.pathfind.result);
  }
}

/** 点击搜索：先显示“搜索中”，下一帧再执行同步 BFS（≤2s），避免界面无反馈。 */
function runPathfind() {
  if (reviewGuard()) return;
  if (!app.plan.rows || app.plan.rows > 4 || app.plan.cols > 4) return;
  if (!$('pathCell').value) return;
  const btn = $('pathSearchBtn');
  btn.disabled = true;
  $('pathStatus').className = 'hint';
  $('pathStatus').textContent = '搜索中…（最多 8 步、2 秒）';
  $('pathResults').hidden = true;
  setTimeout(doPathfindSearch, 20);
}

function doPathfindSearch() {
  const target = { cell: $('pathCell').value, face: $('pathFace').value };
  const status = $('pathStatus');
  let result;
  try {
    result = E.findFoldPath(
      app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps,
      target, { maxDepth: 8, timeoutMs: 2000 });
  } catch (e) {
    result = { ok: false, code: 'bad_prefix', message: e.message };
  }
  $('pathSearchBtn').disabled = false;
  if (!result.ok) {
    status.className = 'hint path-status-err';
    status.textContent = '无法搜索：' + result.message;
    app.pathfind.result = null;
    $('pathResults').hidden = true;
    return;
  }
  app.pathfind.result = result;
  app.pathfind.sig = pathfindSignature();
  app.pathfind.target = `${target.cell}|${target.face}`;
  renderPathResults(result);
}

function renderPathResults(result) {
  const status = $('pathStatus');
  const box = $('pathResults');
  box.innerHTML = '';
  if (!result.solved) {
    box.hidden = true;
    status.className = 'hint path-status-err';
    if (result.reason === 'no_solution') {
      status.textContent = `无解：${result.message}`;
    } else {
      status.textContent = `搜索超限：${result.message}`;
    }
    return;
  }
  box.hidden = false;
  status.className = 'hint path-status-ok';
  const faceName = result.solutions[0].coverFace === 'front' ? '正面' : '反面';
  status.textContent =
    `找到 ${result.solutions.length} 条等长最短方案：各需 ${result.depth} 个后续步骤` +
    `，封面 = 原格(${result.solutions[0].topPanel}) 的${faceName}朝上（共枚举 ${result.searched.states} 个状态）。`;

  result.solutions.forEach((sol, i) => {
    const card = document.createElement('div');
    card.className = 'path-sol';
    const head = document.createElement('div');
    head.className = 'path-sol-head';
    const title = document.createElement('b');
    title.textContent = `方案 ${i + 1}（${sol.steps.length} 步）`;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `收成于格(${sol.finalCell})`;
    const addBtn = document.createElement('button');
    addBtn.className = 'primary';
    addBtn.textContent = '追加到当前步骤并回放';
    addBtn.addEventListener('click', () => appendPathSolution(sol));
    head.append(title, meta, addBtn);
    card.appendChild(head);

    const ol = document.createElement('ol');
    ol.className = 'path-step-list';
    sol.steps.forEach((st, j) => {
      const li = document.createElement('li');
      li.textContent = `第 ${app.plan.steps.length + j + 1} 步：${E.describeStep(st)}`;
      ol.appendChild(li);
    });
    card.appendChild(ol);
    box.appendChild(card);
  });
}

/** 把任一搜索方案追加为后续步骤，进入既有回放流程（末态）。 */
function appendPathSolution(sol) {
  if (reviewGuard()) return;
  if (!app.pathfind.result || app.pathfind.sig !== pathfindSignature()) return;
  for (const st of sol.steps) {
    const base = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps).state;
    if (E.validateFold(base, st)) return;   // 理论上不会发生（方案由合法路径给出）
    app.plan.steps.push({ axis: st.axis, line: st.line, dir: st.dir });
  }
  app.pathfind.result = null;   // 末态已变，旧结果作废
  clearFoldError();
  setUpto(app.plan.steps.length, true);
  $('saveMsg').textContent = '已把自动寻路方案追加到当前步骤，可继续编辑或保存。';
}

// ---------- 面片轨迹 ----------
/** 重建“原始纸格”下拉（仅网格尺寸变化时重建，尽量保留选择）。 */
function refreshTrackCells() {
  const key = `${app.plan.rows}x${app.plan.cols}`;
  if (app.track.gridKey === key) return;
  app.track.gridKey = key;
  const sel = $('trackCell');
  const prev = sel.value;
  sel.innerHTML = '';
  if (!app.plan.rows) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '（先创建网格）';
    sel.appendChild(o);
    return;
  }
  for (let y = 0; y < app.plan.rows; y++) {
    for (let x = 0; x < app.plan.cols; x++) {
      const id = `${x},${y}`;
      const lab = app.plan.labels[id] || {};
      const f = lab.front || '', b = lab.back || '';
      const o = document.createElement('option');
      o.value = id;
      o.textContent = `原格(${id})` + (f || b ? `  正:${f || '空'} / 反:${b || '空'}` : '');
      sel.appendChild(o);
    }
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

/**
 * 渲染面片轨迹卡片。
 * 网格、标注或步骤变化后由 render() 自动调用，重新计算时间线。
 * @param forceCell/forceFace 下拉 change 时显式指定选择
 */
function renderTrack(forceCell, forceFace) {
  refreshTrackCells();
  const status = $('trackStatus');
  const box = $('trackTimeline');
  if (!app.plan.rows) {
    app.track.result = null;
    app.track.target = null;
    status.className = 'hint';
    status.textContent = '先在左侧创建行列纸格。';
    box.hidden = true;
    box.innerHTML = '';
    draw();
    return;
  }
  const cell = forceCell != null ? forceCell : $('trackCell').value;
  const face = forceFace != null ? forceFace : $('trackFace').value;
  if (forceCell != null) $('trackCell').value = cell;
  if (forceFace != null) $('trackFace').value = face;
  if (!cell) {
    app.track.result = null;
    app.track.target = null;
    status.className = 'hint';
    status.textContent = '请选择一个原始纸格与其正/反面。';
    box.hidden = true;
    draw();
    return;
  }

  const result = E.trackPanel(
    app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps,
    { cell, face: face === 'back' ? 'back' : 'front' });
  if (!result.ok) {
    app.track.result = null;
    app.track.target = null;
    status.className = 'hint track-status-err';
    status.textContent = result.message;
    box.hidden = true;
    draw();
    return;
  }

  app.track.result = result;
  app.track.target = { cell, face: result.target.face };

  status.className = 'hint' + (result.interrupted ? ' track-status-err' : ' track-status-ok');
  const faceName = result.target.face === 'front' ? '正面' : '反面';
  status.innerHTML = result.interrupted
    ? `追踪原格(${cell}) 的${faceName}：第 ${result.interrupted.stepIndex + 1} 步非法` +
      `（${result.interrupted.code === 'thickness' ? '厚度不一致' : '折线不在外轮廓'}），` +
      `时间线在第 ${result.points.length - 1} 步后中断。`
    : `追踪原格(${cell}) 的${faceName}：共 ${result.points.length - 1} 步，` +
      `当前末态位于格(${result.points[result.points.length - 1].cell})。`;

  renderTrackTimeline(result);
  draw();
}

function renderTrackTimeline(result) {
  const box = $('trackTimeline');
  box.innerHTML = '';
  box.hidden = false;
  const lastValidStep = result.points[result.points.length - 1].step;
  const currentStep = app.upto <= lastValidStep ? app.upto : lastValidStep;
  const stalled = app.upto > lastValidStep;   // 回放停在中断步（非法）上

  result.points.forEach((p, i) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'track-node'
      + (p.step === currentStep ? ' current' : '')
      + (stalled && p.step === lastValidStep ? ' stalled' : '')
      + (p.step > currentStep ? ' future' : '');
    const up = p.faceUp ? '朝上' : '朝下';
    const upright = p.upright
      ? '正立'
      : '<span class="track-inv">倒置</span>';
    const labelTxt = p.label == null ? '空白' : escapeHtml(p.label);
    node.innerHTML =
      `<span class="track-step">第 ${p.step} 步</span>` +
      `<span class="track-cell">格(${p.cell})</span>` +
      `<span class="track-meta">层 <b>${p.layer}/${p.depth}</b></span>` +
      `<span class="track-meta ${p.faceUp ? 'track-up' : 'track-down'}">` +
        `${result.target.face === 'front' ? '正' : '反'}${up}</span>` +
      `<span class="track-meta">${upright}</span>` +
      `<span class="track-label">${labelTxt}</span>`;
    node.title = `定位到第 ${p.step} 步回放，并高亮原格(${result.target.cell})`;
    node.addEventListener('click', () => jumpTrackPoint(p.step));
    box.appendChild(node);

    if (i < result.points.length - 1) {
      const arrow = document.createElement('span');
      arrow.className = 'track-arrow';
      arrow.textContent = '→';
      box.appendChild(arrow);
    }
  });

  if (result.interrupted) {
    const it = result.interrupted;
    const arrow = document.createElement('span');
    arrow.className = 'track-arrow';
    arrow.textContent = '→';
    box.appendChild(arrow);
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'track-node break' + (stalled ? ' current' : ' future');
    stop.innerHTML =
      `<span class="track-step">第 ${it.stepIndex + 1} 步</span>` +
      `<span class="track-stop">⛔ 中断</span>` +
      `<span class="track-reason">${it.code === 'thickness' ? '厚度不一致' : '折线不在外轮廓'}</span>` +
      (it.conflicts.length ? `<span class="track-reason">冲突 ${it.conflicts.slice(0, 4).map(escapeHtml).join('、')}${
        it.conflicts.length > 4 ? '…' : ''}</span>` : '');
    stop.title = escapeHtml(it.message) + '\n点击定位到中断前的最后一步。';
    stop.addEventListener('click', () => jumpTrackPoint(lastValidStep));
    box.appendChild(stop);
  }
}

/** 点击时间线节点：联动既有回放定位到该步（节点面板由 draw 按目标身份高亮）。 */
function jumpTrackPoint(step) {
  setUpto(step, true);
}

// ---------- 双面印刷版预览 ----------
/** 渲染右侧卡片：可用性、禁用原因。 */
function renderDuplex() {
  const btn = $('duplexOpenBtn');
  const status = $('duplexStatus');
  if (!app.plan.rows) {
    app.duplex.eligible = null;
    btn.disabled = true;
    status.className = 'hint';
    status.textContent = '先在左侧创建行列纸格并完成折叠。';
    syncDuplexOverlay();
    return;
  }
  const elig = E.duplexEligibility(
    app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps);
  app.duplex.eligible = elig;
  if (elig.ok) {
    btn.disabled = false;
    status.className = 'hint duplex-status-ok';
    status.textContent = `可生成双面版：当前方案合法且已收成单叠（容量 ${elig.capacity} 面）。`;
  } else {
    btn.disabled = true;
    status.className = 'hint duplex-status-err';
    status.textContent = elig.code === 'not_single_stack'
      ? `禁用预览：尚未收成单叠（${elig.message}）`
      : `禁用预览：${elig.message}`;
  }
  syncDuplexOverlay();
}

/** 打开覆盖层并生成两版。 */
function openDuplex() {
  // 审阅模式允许只读查看双面版（不修改方案）
  if (!app.versions.review && reviewGuard()) return;
  if (!app.duplex.eligible || !app.duplex.eligible.ok) return;
  app.duplex.flip = $('duplexFlip').value === 'short' ? 'short' : 'long';
  $('duplexFlipOverlay').value = app.duplex.flip;
  app.duplex.open = true;
  $('duplexOverlay').hidden = false;
  renderDuplexPreview();
}

function closeDuplex() {
  app.duplex.open = false;
  $('duplexOverlay').hidden = true;
  app.duplex.result = null;
  app.duplex.sig = null;
}

/**
 * 覆盖层打开期间方案被改动（回放/编辑/存取都会触发 render）：
 * 若几何签名变化则即时重算；变得不可用时自动关闭并给出原因。
 */
function syncDuplexOverlay() {
  if (!app.duplex.open) return;
  if (!app.duplex.eligible || !app.duplex.eligible.ok) {
    closeDuplex();
    return;
  }
  if (!app.duplex.result || app.duplex.sig !== planSignature()
      || app.duplex.result.flip !== app.duplex.flip) {
    renderDuplexPreview();
  }
}

/** 依据当前方案与翻面方式生成两版并填充 DOM。 */
function renderDuplexPreview() {
  if (!app.duplex.open) return;
  const result = E.buildDuplexPlates(
    app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps, app.duplex.flip);
  if (!result.ok) { closeDuplex(); return; }
  app.duplex.result = result;
  app.duplex.sig = planSignature();

  const flipText = result.flip === 'long'
    ? '长边翻转：沿纸张<b>竖边</b>左右翻面（打印机选“双面 / 沿长边翻页”）'
    : '短边翻转：沿纸张<b>横边</b>上下翻面（打印机选“双面 / 沿短边翻页 / 翻转”）';
  $('duplexScreenNote').innerHTML = flipText;

  const mirrorText = result.flip === 'long' ? '背面版须左右镜像' : '背面版须上下镜像';
  $('plateFrontMeta').textContent =
    `${result.rows} 行 × ${result.cols} 列 · 纸格按原始行列位置排列 · 坐标为“列,行”（0 基）`;
  $('plateBackMeta').textContent =
    `${result.rows} 行 × ${result.cols} 列 · ${mirrorText} · 坐标为“列,行”（0 基）`;

  renderPlateSheet($('plateFrontSheet'), result.front, result);
  renderPlateSheet($('plateBackSheet'), result.back, result);
}

function renderPlateSheet(sheetEl, plate, result) {
  sheetEl.innerHTML = '';
  sheetEl.style.gridTemplateColumns = `repeat(${result.cols}, minmax(0, 1fr))`;
  sheetEl.style.setProperty('--plate-rows', String(result.rows));
  // 屏幕上行高不指定：交由格内 aspect-ratio:1/1 推出，避免 fr 行在 auto 高度容器中塌陷；
  // 打印样式改为等分行铺满一页（见 styles.css @media print）。

  for (const row of plate.grid) {
    for (const c of row) {
      const cell = document.createElement('div');
      cell.className = 'plate-cell face-' + c.face + (c.blank ? ' blank-cell' : '');
      cell.dataset.origin = c.origin;
      cell.dataset.face = c.face;

      const origin = document.createElement('span');
      origin.className = 'cell-origin';
      origin.textContent = `原格(${c.origin})`;

      const face = document.createElement('span');
      face.className = 'cell-face';
      face.textContent = c.face === 'front' ? '正面' : '反面';

      const rot = document.createElement('span');
      rot.className = 'cell-rot ' + (c.rotate ? 'r180' : 'r0');
      rot.textContent = c.rotate ? '⟲ 旋转 180°' : '0° 不转';
      rot.title = c.rotate
        ? '制版时把该面整体旋转 180°（倒置补偿，折叠后阅读正立）'
        : '制版时保持原朝向';

      const glyph = document.createElement('span');
      glyph.className = 'glyph' + (c.rotate ? ' rot180' : '') + (c.blank ? ' blank' : '');
      glyph.textContent = c.blank ? '空白面（占位）' : c.label;

      cell.append(origin, face, glyph, rot);
      sheetEl.appendChild(cell);
    }
  }

  // 翻转边标识（彩条）：长边=竖边，短边=横边；背面在镜像后的对边
  const edge = document.createElement('div');
  edge.className = 'flip-edge';
  const bar = document.createElement('span');
  bar.className = 'edge-bar' + (result.flip === 'short' ? ' short-edge' : '');
  const txt = document.createElement('span');
  const sideName = { left: '左竖边', right: '右竖边', top: '上横边', bottom: '下横边' }[plate.edge];
  txt.innerHTML = `翻面装订边：<b>${sideName}</b>` +
    (plate.mirrored
      ? `（背面视图；该边即印刷后沿之翻面的${result.flip === 'long' ? '长边' : '短边'}）`
      : `（正面视图；与背面版${result.flip === 'long' ? '左' : '下'}边为同一条${result.flip === 'long' ? '长' : '短'}边）`);
  edge.append(bar, txt);
  sheetEl.parentElement?.querySelectorAll('.flip-edge').forEach((n) => n.remove());
  sheetEl.parentElement?.appendChild(edge);
}

// ---------- 书帖爬移补偿 ----------
/**
 * 卡片始终基于“全部步骤回放末态”实时重算（与回放停在第几步无关），
 * 网格、折叠步骤或参数（纸厚/出血）变化后 render() 自动调用。
 * 应用（“应用补偿”）后才把参数与逐面偏移写入 plan.creepCompensation 独立字段。
 */
function creepBasisSignature() {
  return JSON.stringify({ r: app.plan.rows, c: app.plan.cols, s: app.plan.steps });
}

function fmtNum(n) {
  return String(Math.round(n * 1000) / 1000);
}

/** 用当前末态 + 输入参数计算爬移补偿（参数非法时给出引擎错误对象）。 */
function computeCreep() {
  const t = Number($('creepThickness').value);
  const b = Number($('creepBleed').value);
  return {
    t, b,
    result: E.creepCompensation(
      app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps, t, b)
  };
}

/** 已应用方案与当前几何/参数是否仍一致（current 为非法结果时只判几何签名）。 */
function creepSchemeStale(scheme, result) {
  if (!scheme) return false;
  if (scheme.basis && scheme.basis.stepsSignature !== creepBasisSignature()) return true;
  if (!result) return true;
  const p = scheme.params || {};
  return Number(p.paperThickness) !== result.paperThickness || Number(p.bleed) !== result.bleed;
}

function renderCreep() {
  const btn = $('creepApplyBtn');
  const clearBtn = $('creepClearBtn');
  const status = $('creepStatus');
  const summary = $('creepSummary');
  const appliedBox = $('creepApplied');
  const wrap = $('creepTableWrap');
  const tbody = $('creepRows');
  const scheme = app.plan.creepCompensation || null;
  clearBtn.hidden = !scheme;

  if (!app.plan.rows) {
    app.creep.eligible = null;
    app.creep.result = null;
    btn.disabled = true;
    status.className = 'hint';
    status.textContent = '先在左侧创建行列纸格并完成折叠。';
    summary.hidden = true;
    appliedBox.hidden = true;
    wrap.hidden = true;
    tbody.innerHTML = '';
    return;
  }

  const { result } = computeCreep();
  app.creep.result = result;

  if (!result.ok) {
    app.creep.eligible = result;
    btn.disabled = true;
    status.className = 'hint creep-status-err';
    if (result.code === 'bad_thickness' || result.code === 'bad_bleed') {
      status.textContent = '禁用应用：' + result.message;
    } else if (result.code === 'not_single_stack') {
      status.textContent = `禁用应用：尚未收成单叠（${result.message}）`;
    } else {
      status.textContent = `禁用应用：存在非法折叠${
        result.stepIndex != null ? `（第 ${result.stepIndex + 1} 步）` : ''}：${result.message}`;
    }
    summary.hidden = true;
    wrap.hidden = true;
    tbody.innerHTML = '';
    renderCreepApplied(scheme, null);
    return;
  }

  app.creep.eligible = { ok: true };
  renderCreepTable(result);
  renderCreepSummary(result);
  btn.disabled = !result.canApply;
  status.className = 'hint ' + (result.canApply ? 'creep-status-ok' : 'creep-status-err');
  if (result.canApply) {
    status.textContent = `可应用：最大补偿 ${fmtNum(result.maxCompensation)}（${
      result.leafCount} 叶），所有偏移均在可用出血 ${fmtNum(result.bleed)} 以内。`;
  } else {
    status.textContent =
      `禁用应用：${result.overBleedCount} 个面的偏移绝对值超过可用出血 ${fmtNum(result.bleed)}` +
      '（下表红色行），请加大出血或改用更薄纸张。';
  }
  renderCreepApplied(scheme, result);
}

function renderCreepSummary(result) {
  const box = $('creepSummary');
  const spineName = { left: '左缘（竖折脊）', right: '右缘（竖折脊）', top: '上缘（横折脊）', bottom: '下缘（横折脊）' }[result.spineSide];
  box.hidden = false;
  box.innerHTML =
    `书脊位置：<b>${spineName || '未折叠（无书脊）'}</b>；内容沿前口→书脊方向逐叶内移。` +
    `共 <b>${result.leafCount}</b> 叶，最外叶补偿 0，<b>最大补偿 = 纸厚 ${
      fmtNum(result.paperThickness)} × ${Math.max(0, result.leafCount - 1)} = ${
      fmtNum(result.maxCompensation)}</b>。偏移单位与输入一致（如 mm）。`;
}

function renderCreepTable(result) {
  const wrap = $('creepTableWrap');
  const tbody = $('creepRows');
  wrap.hidden = false;
  tbody.innerHTML = '';
  result.leaves.forEach((lf) => {
    const over = lf.front.overBleed || lf.back.overBleed;
    const tr = document.createElement('tr');
    tr.className = (over ? 'creep-over ' : '')
      + (lf.leafIndex === 0 ? 'leaf-cover' : '')
      + (lf.leafIndex === result.leaves.length - 1 ? ' leaf-center' : '');

    const layerName = lf.leafIndex === 0 ? `${lf.leafIndex}（最外叶·封面）`
      : lf.leafIndex === result.leaves.length - 1 ? `${lf.leafIndex}（最内叶·中缝）`
      : String(lf.leafIndex);
    const axisName = lf.axis === 'x' ? '横' : '纵';
    const faceCell = (f) => {
      const sign = f.offset > 0 ? '+' : '';
      return `<span title="${f.dx === 0 ? '' : '原格 dx=' + fmtNum(f.dx) + '；'}${f.dy === 0 ? '' : '原格 dy=' + fmtNum(f.dy)}">` +
        `${sign}${fmtNum(f.offset)} <span class="creep-axis">${axisName}</span>${f.overBleed ? ' ⚠超出血' : ''}</span>`;
    };
    tr.innerHTML =
      `<td>${layerName}</td>` +
      `<td>格(${lf.origin})</td>` +
      `<td class="num">${lf.outsideCount}</td>` +
      `<td class="num">${fmtNum(lf.creep)}</td>` +
      `<td class="num creep-off">${faceCell(lf.front)}</td>` +
      `<td class="num creep-off">${faceCell(lf.back)}</td>`;
    tbody.appendChild(tr);
  });
}

/** 已应用方案提示：保留时显示参数与状态；几何/参数已变时标黄提示需重新应用。 */
function renderCreepApplied(scheme, current) {
  const box = $('creepApplied');
  if (!scheme) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  const stale = creepSchemeStale(scheme, current);
  box.className = 'creep-applied' + (stale ? ' stale' : '');
  const faceCount = Object.keys(scheme.faces || {}).length;
  box.innerHTML = stale
    ? `⚠ 已应用的爬移补偿（纸厚 ${scheme.params.paperThickness}、出血 ${scheme.params.bleed}，` +
      `${faceCount} 个原始纸格）与当前网格/步骤/参数不一致：字段仍随方案保留，` +
      '请在参数修正后重新“应用补偿”，或“清除已应用”。'
    : `✓ 已应用爬移补偿：纸厚 ${scheme.params.paperThickness}、出血 ${scheme.params.bleed}，` +
      `最大补偿 ${scheme.maxCompensation != null ? scheme.maxCompensation : '—'}，` +
      `逐面偏移已写入方案独立字段（${faceCount} 个原始纸格），保存/导入/服务端载入均保留。`;
}

/** 应用：把当前参数与逐面偏移固化到 plan.creepCompensation 独立字段。 */
function applyCreep() {
  if (reviewGuard()) return;
  const { result } = computeCreep();
  if (!result.ok || !result.canApply) return;
  const faces = {};
  for (const lf of result.leaves) {
    faces[lf.origin] = {
      front: lf.front.offset,
      back: lf.back.offset,
      axis: lf.axis,
      creep: lf.creep
    };
  }
  app.plan.creepCompensation = {
    params: { paperThickness: result.paperThickness, bleed: result.bleed },
    spineAxis: result.spineAxis,
    spineSide: result.spineSide,
    maxCompensation: result.maxCompensation,
    faces,
    basis: {
      rows: result.rows,
      cols: result.cols,
      stepsSignature: creepBasisSignature()
    },
    appliedAt: new Date().toISOString()
  };
  renderCreep();
  $('saveMsg').textContent =
    `已应用书帖爬移补偿（${result.leaves.length} 叶，最大补偿 ${fmtNum(result.maxCompensation)}），记得保存方案。`;
}

/** 清除已应用字段（实时明细表仍按当前参数展示）。 */
function clearCreep() {
  if (reviewGuard()) return;
  delete app.plan.creepCompensation;
  renderCreep();
  $('saveMsg').textContent = '已清除爬移补偿独立字段（需保存方案后生效）。';
}

// ---------- 生产质量审计 ----------
/**
 * 渲染审计卡片：始终对“全部步骤”完整重放（与回放停在第几步无关），
 * 结果只读；方案含非法步骤时仅报告首个错误，不展示后续检查结论。
 * 网格、标注或步骤变化后由 render() 自动重算。
 */
function renderAudit() {
  const verdictEl = $('auditVerdict');
  const status = $('auditStatus');
  const list = $('auditFindings');
  const exportBtn = $('auditExportBtn');
  if (!app.plan.rows) {
    app.audit.result = null;
    verdictEl.className = 'audit-verdict idle';
    verdictEl.textContent = '未审计';
    status.className = 'hint';
    status.textContent = '先在左侧创建行列纸格。';
    list.hidden = true;
    list.innerHTML = '';
    exportBtn.disabled = true;
    return;
  }
  const result = E.auditPlan(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps);
  app.audit.result = result;
  exportBtn.disabled = false;

  if (!result.ok) {
    verdictEl.className = 'audit-verdict blocked';
    verdictEl.textContent = '⛔ 审计中止';
    status.className = 'hint audit-status-err';
    status.textContent = `第 ${result.stepIndex + 1} 步非法（${
      result.code === 'thickness' ? '厚度不一致' : '折线不在外轮廓'}）：` +
      '仅报告首个错误，不伪造后续检查结论；修正非法步骤后自动重新审计。';
    list.hidden = true;
    list.innerHTML = '';
    return;
  }

  const s = result.summary;
  verdictEl.className = 'audit-verdict ' + (result.verdict === 'pass' ? 'pass' : 'fail');
  verdictEl.textContent = result.verdict === 'pass' ? '✓ 可发布' : '✗ 需修订';
  status.className = 'hint ' + (result.verdict === 'pass' ? 'audit-status-ok' : 'audit-status-err');
  status.textContent =
    `完整重放 ${result.stats.steps} 步：错误 ${s.errors} 条、警告 ${s.warnings} 条` +
    `（容量 ${result.stats.capacity} 面，已标注 ${result.stats.labeledFaces} 面）。` +
    (result.verdict === 'pass' ? ' 结论：可发布。' : ' 结论：需修订后再交付。');

  list.innerHTML = '';
  list.hidden = false;
  if (!result.findings.length) {
    const li = document.createElement('li');
    li.className = 'audit-item info';
    li.innerHTML = '<span class="audit-msg">全部检查通过：未发现空白 / 重复 / 倒置页码、' +
      '分离叠层、未覆盖纸格或容量异常。</span>';
    list.appendChild(li);
    return;
  }
  const sevName = { error: '错误', warning: '警告', info: '提示' };
  for (const f of result.findings) {
    const li = document.createElement('li');
    li.className = 'audit-item ' + f.severity;
    const head = document.createElement('div');
    head.className = 'audit-head';
    head.innerHTML = `<span class="sev ${f.severity}">${sevName[f.severity] || f.severity}</span>` +
      `<span class="audit-title">${escapeHtml(f.title)}</span>`;
    li.appendChild(head);
    const msg = document.createElement('div');
    msg.className = 'audit-msg';
    msg.textContent = f.message;
    li.appendChild(msg);
    if (f.cells && f.cells.length) {
      const cells = document.createElement('div');
      cells.className = 'audit-cells';
      const shown = f.cells.slice(0, 8);
      for (const c of shown) {
        const chip = document.createElement('span');
        chip.className = 'cell-chip';
        chip.textContent = `原格(${c})`;
        cells.appendChild(chip);
      }
      if (f.cells.length > shown.length) {
        const more = document.createElement('span');
        more.className = 'cell-chip';
        more.textContent = `+${f.cells.length - shown.length}`;
        cells.appendChild(more);
      }
      li.appendChild(cells);
    }
    list.appendChild(li);
  }
}

/** 导出审计报告 JSON（方案 + 审计结果，只读不改动方案）。 */
function exportAudit() {
  const result = app.audit.result;
  if (!result) return;
  const report = {
    name: $('planName').value || '未命名方案',
    generatedAt: new Date().toISOString(),
    plan: planPayload(),
    annotations: planPayload().annotations,
    annotationSummary: E.annotationStats(planPayload().annotations),
    audit: result
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fold-audit-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  $('saveMsg').textContent = '已导出生产质量审计报告 JSON。';
}

// ---------- 错误提示 ----------
function showFoldError(err) {
  const box = $('foldError');
  box.hidden = false;
  box.textContent =
    (err.code === 'thickness' ? '⛔ 拒绝执行：两侧厚度不一致。' : '⛔ 拒绝执行：折线不在当前外轮廓。')
    + '\n' + err.message
    + (err.conflicts.length ? `\n冲突纸格：${[...new Set(err.conflicts)].join('、')}（画布中红底标出）` : '');
}
function clearFoldError() { $('foldError').hidden = true; }

// ---------- 标签 / 备注 ----------
/** 添加单个标签：先在前端按服务端同一份规则预校验/规范化（去重、限量、限长、禁字符）。 */
function addTag(raw) {
  const tag = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!tag) { $('saveMsg').textContent = '标签不能为空。'; return false; }
  if ([...tag].length > E.META_LIMITS.MAX_TAG_LEN) {
    $('saveMsg').textContent = `单个标签最多 ${E.META_LIMITS.MAX_TAG_LEN} 字符。`;
    return false;
  }
  if (/[\p{C},;|]/u.test(tag)) {
    $('saveMsg').textContent = '标签不能包含控制字符或 , ; | 等分隔符。';
    return false;
  }
  if (app.plan.tags.includes(tag)) { $('saveMsg').textContent = `标签“${tag}”已存在。`; return false; }
  if (app.plan.tags.length >= E.META_LIMITS.MAX_TAGS) {
    $('saveMsg').textContent = `每个方案最多 ${E.META_LIMITS.MAX_TAGS} 个标签。`;
    return false;
  }
  app.plan.tags.push(tag);
  renderTagChips();
  return true;
}

function addTagFromInput() {
  const input = $('tagInput');
  if (addTag(input.value)) input.value = '';
  input.focus();
}

function removeTag(tag) {
  app.plan.tags = app.plan.tags.filter((t) => t !== tag);
  renderTagChips();
}

function clearTags() {
  if (!app.plan.tags.length) return;
  app.plan.tags = [];
  renderTagChips();
  $('saveMsg').textContent = '已清除全部标签（保存方案后生效）。';
}

function renderTagChips() {
  const box = $('tagChips');
  box.innerHTML = '';
  app.plan.tags.forEach((tag) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    const txt = document.createElement('span');
    txt.className = 'tag-chip-name';
    txt.textContent = tag;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'tag-chip-x';
    x.title = '删除该标签';
    x.textContent = '×';
    x.addEventListener('click', () => removeTag(tag));
    chip.append(txt, x);
    box.appendChild(chip);
  });
  if (!app.plan.tags.length) {
    const empty = document.createElement('span');
    empty.className = 'muted tag-empty';
    empty.textContent = '尚无标签（可添加 0～8 个）';
    box.appendChild(empty);
  }
  $('tagCountHint').textContent = `${app.plan.tags.length} / ${E.META_LIMITS.MAX_TAGS} 个标签`;
}

// ---------- 存取 ----------
function planPayload() {
  const p = {
    name: $('planName').value || '未命名方案',
    rows: app.plan.rows,
    cols: app.plan.cols,
    labels: app.plan.labels,
    steps: app.plan.steps,
    tags: app.plan.tags,
    note: $('planNote').value,
    annotations: Array.isArray(app.plan.annotations) ? app.plan.annotations : []
  };
  // 爬移补偿独立方案字段：应用后随保存/导出保留
  if (app.plan.creepCompensation) p.creepCompensation = app.plan.creepCompensation;
  return p;
}

function applyPlan(plan, id) {
  const p = E.normalizePlan(plan);
  app.plan = p;
  app.loadedId = id || null;
  app.annotation.editing = null;
  app.annotation.selectedId = null;
  resetVersionState();
  hydratePlanForm(p);
  refreshLineSelect();
  setUpto(p.steps.length, true);
  $('deletePlanBtn').hidden = !id;
  fillVersionSelectors([]);
  $('saveMsg').textContent = id
    ? `已载入服务器存档 ${id}（批注 ${p.annotations.length} 条）`
    : `已载入 JSON 文件（批注 ${p.annotations.length} 条）`;
  // 载入服务器存档后拉取其不可变版本列表；导入本地 JSON 无版本
  if (id) refreshVersions(id);
}

/** 把方案内容回填到编辑控件（正常载入与历史版本审阅共用）。 */
function hydratePlanForm(p) {
  $('annoOpenOnly').checked = false;
  $('annoSeverityFilter').value = '';
  $('annoFaceFilter').value = '';
  $('planName').value = p.name;
  $('rowsInput').value = p.rows;
  $('colsInput').value = p.cols;
  $('planNote').value = p.note || '';
  renderTagChips();
  // 载入已应用的爬移补偿方案：回填参数输入框（逐面偏移在独立字段中保留）
  if (p.creepCompensation && p.creepCompensation.params) {
    $('creepThickness').value = p.creepCompensation.params.paperThickness;
    $('creepBleed').value = p.creepCompensation.params.bleed;
  }
}

async function savePlan() {
  if (!app.plan.rows) { $('saveMsg').textContent = '请先创建网格。'; return; }
  if (app.versions.review) {
    $('saveMsg').textContent = '历史版本为只读快照，不能直接保存；请先“恢复为当前草稿”或“返回当前草稿”。';
    return;
  }
  // 与服务端同一份严格校验：非法标签/过长输入在本地即被拦下，请求也不会改动旧存档
  try {
    E.normalizePlanMeta(planPayload());
  } catch (e) {
    $('saveMsg').textContent = '保存被拒绝：' + e.message;
    return;
  }
  // 批注同样走严格校验（任一条非法都整请求拒绝）
  try {
    E.normalizeAnnotations(planPayload().annotations, {
      rows: app.plan.rows, cols: app.plan.cols, steps: app.plan.steps
    });
  } catch (e) {
    $('saveMsg').textContent = '保存被拒绝：' + e.message;
    return;
  }
  try {
    const resp = await fetch('/api/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...planPayload(),
        id: app.loadedId || undefined,
        restoredFromVersion: app.versions.restoreMarker || undefined
      })
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error.message);
    app.loadedId = data.id;
    app.versions.planId = data.id;
    app.versions.restoreMarker = null;
    app.plan.tags = data.plan.tags;
    if (Array.isArray(data.plan.annotations)) app.plan.annotations = data.plan.annotations;
    $('deletePlanBtn').hidden = false;
    $('saveMsg').textContent = `已保存：${data.id}（${new Date().toLocaleTimeString()}，版本 v${data.version}）`;
    // 刷新不可变版本列表：默认选中最近两个版本便于立即比较
    await refreshVersions(data.id, { selectLatest: true });
    // 列表若处于打开状态则自动刷新（沿用当前筛选）
    if (!$('planList').hidden) loadList();
  } catch (e) {
    $('saveMsg').textContent = '保存失败：' + e.message;
  }
}

function exportPlan() {
  if (reviewGuard('历史版本为只读快照，请先恢复为草稿再导出。')) return;
  if (!app.plan.rows) { $('saveMsg').textContent = '请先创建网格。'; return; }
  const blob = new Blob([JSON.stringify(planPayload(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fold-plan-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importPlan(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (app.versions.review) {
    e.target.value = '';
    reviewGuard('请先退出版本审阅（返回草稿或恢复为草稿）再导入方案。');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyPlan(JSON.parse(reader.result), null);
    } catch (err) {
      alert('方案 JSON 无法载入：\n' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

/** 按当前筛选条件拉取存档列表（标签交集 / 名称关键词 / 最近更新时间）。 */
async function loadList() {
  const ul = $('planList');
  ul.hidden = false;
  $('planFilter').hidden = false;
  ul.innerHTML = '<li class="muted">加载中…</li>';
  const params = new URLSearchParams();
  if (app.listFilter.tags) params.set('tags', app.listFilter.tags);
  if (app.listFilter.q) params.set('q', app.listFilter.q);
  if (app.listFilter.since) {
    params.set('since', String(Date.now() - Number(app.listFilter.since)));
  }
  const qs = params.toString();
  try {
    const resp = await fetch('/api/plans' + (qs ? `?${qs}` : ''));
    const data = await resp.json();
    if (!resp.ok) throw new Error((data.error && data.error.message) || `HTTP ${resp.status}`);
    renderPlanList(data);
  } catch (e) {
    ul.innerHTML = `<li class="muted">读取失败：${escapeHtml(e.message)}</li>`;
  }
}

function renderPlanList(data) {
  const ul = $('planList');
  ul.innerHTML = '';
  const filtering = app.listFilter.tags || app.listFilter.q || app.listFilter.since;
  $('planFilterMsg').textContent = filtering
    ? `筛选命中 ${data.matched} / ${data.total} 个存档（按最近更新时间排序）`
    : `共 ${data.total} 个存档（按最近更新时间排序）`;
  if (!data.items.length) {
    ul.innerHTML = `<li class="muted">${filtering ? '没有符合筛选条件的存档' : '服务器上还没有存档'}</li>`;
    return;
  }
  data.items.forEach((it) => {
    const li = document.createElement('li');
    li.className = 'plan-list-item';

    const main = document.createElement('div');
    main.className = 'plan-item-main';
    const info = document.createElement('div');
    info.className = 'plan-item-info';
    const annoPart = it.annotations
      ? ` · 批注 ${it.openAnnotations != null ? it.openAnnotations + ' 未解决 / ' : ''}${it.annotations}`
      : '';
    info.textContent = `${it.name}（${it.rows}×${it.cols}，${it.steps} 步${annoPart}）`;
    const meta = document.createElement('div');
    meta.className = 'plan-item-meta muted';
    meta.textContent = `更新于 ${new Date(it.updatedAt).toLocaleString()}`;

    const tagBox = document.createElement('div');
    tagBox.className = 'plan-item-tags';
    (it.tags || []).forEach((tag) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip tag-chip-link';
      chip.title = `按标签“${tag}”筛选`;
      chip.textContent = '#' + tag;
      chip.addEventListener('click', () => {
        const cur = $('filterTags').value.split(',').map((s) => s.trim()).filter(Boolean);
        if (!cur.includes(tag)) cur.push(tag);
        $('filterTags').value = cur.join(',');
        $('filterApplyBtn').click();
      });
      tagBox.appendChild(chip);
    });
    if (it.note) {
      const note = document.createElement('div');
      note.className = 'plan-item-note muted';
      note.textContent = it.note;
      note.title = it.note;
      main.append(info, tagBox, note, meta);
    } else {
      main.append(info, tagBox, meta);
    }

    const btn = document.createElement('button');
    btn.textContent = '载入';
    btn.addEventListener('click', async () => {
      const r = await fetch(`/api/plans/${it.id}`);
      applyPlan(await r.json(), it.id);
    });
    li.append(main, btn);
    ul.appendChild(li);
  });
}

async function deleteLoaded() {
  if (!app.loadedId) return;
  if (!confirm('确定删除服务器上的该存档？将同时删除全部不可变历史版本。')) return;
  await fetch(`/api/plans/${app.loadedId}`, { method: 'DELETE' });
  app.loadedId = null;
  resetVersionState();
  fillVersionSelectors([]);
  renderVersionCard();
  $('deletePlanBtn').hidden = true;
  $('saveMsg').textContent = '已删除存档及其历史版本（本地方案仍保留）';
  if (!$('planList').hidden) loadList();
}

// ==========================================================================
// 版本差异审阅
// --------------
// 每次成功保存后服务端保留不可变快照；前端选择同一方案的两个版本：
//   - 以原始纸格 + 步骤序号为稳定身份展示增删改；
//   - 画布紫色高亮受影响纸格，点击差异联动回放对应版本（只读审阅）；
//   - 任一历史版本可恢复为当前草稿（确认后作为新草稿，不覆盖任何历史；
//     下一次保存沿既有流程追加新版本）。
// ==========================================================================

/** 审阅模式守卫：处于只读审阅时拦截一切方案变更操作。 */
function reviewGuard(msg) {
  if (!app.versions.review) return false;
  $('saveMsg').textContent = msg
    || '正在审阅历史只读版本：请先“返回当前草稿”或“恢复为当前草稿”。';
  return true;
}

function resetVersionState() {
  app.versions.planId = null;
  app.versions.list = null;
  app.versions.diff = null;
  app.versions.review = null;
  app.versions.restoreMarker = null;
  app.diffFocus = { cells: [], step: null, annoId: null };
}

/** 保存成功后刷新版本卡（失败静默：版本为保存的附属能力，不阻断主流程提示）。 */
async function refreshVersions(planId, { selectLatest } = {}) {
  if (!planId) return;
  try {
    const resp = await fetch(`/api/plans/${encodeURIComponent(planId)}/versions`);
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error((data.error && data.error.message) || `HTTP ${resp.status}`);
    app.versions.planId = planId;
    app.versions.list = data.versions;
    fillVersionSelectors(data.versions, selectLatest ? { from: Math.max(1, data.latest - 1), to: data.latest } : null);
    renderVersionCard();
  } catch (e) {
    $('versionStatus').textContent = '历史版本读取失败：' + e.message;
  }
}

function versionLabel(v) {
  const t = v.savedAt ? new Date(v.savedAt).toLocaleString() : '时间未知';
  const reason = v.reason === 'restore'
    ? `（恢复自 v${v.restoredFromVersion || '?'}）` : '';
  return `v${v.version} · ${t}${reason} · ${v.steps} 步 · 批注 ${v.annotations}`;
}

function fillVersionSelectors(list, prefer) {
  const fill = (sel, placeholder) => {
    sel.innerHTML = '';
    const o0 = document.createElement('option');
    o0.value = '';
    o0.textContent = placeholder;
    sel.appendChild(o0);
    (list || []).forEach((v) => {
      const o = document.createElement('option');
      o.value = String(v.version);
      o.textContent = versionLabel(v);
      sel.appendChild(o);
    });
  };
  fill($('diffTo'), '选择新版本…');
  const sFrom = $('diffFrom');
  const sTo = $('diffTo');
  const listArr = list || [];
  if (listArr.length >= 2) {
    sFrom.value = String(prefer && listArr.some((v) => v.version === prefer.from)
      ? prefer.from : listArr[listArr.length - 2].version);
    sTo.value = String(prefer && listArr.some((v) => v.version === prefer.to)
      ? prefer.to : listArr[listArr.length - 1].version);
  }
  $('diffBtn').disabled = listArr.length < 2 || !sFrom.value || !sTo.value
    || sFrom.value === sTo.value;
}

function renderVersionCard() {
  const st = $('versionStatus');
  const btn = $('reviewVersionsBtn');
  const list = app.versions.list;
  btn.hidden = !list || list.length === 0;
  if (!app.loadedId) {
    st.textContent = '保存方案到服务器后即可比较历史版本。';
  } else if (!list) {
    st.textContent = '版本列表尚未加载，保存方案后自动加载。';
  } else if (list.length === 0) {
    st.textContent = '该存档还没有版本快照（再次保存即生成首个不可变版本）。';
  } else {
    st.textContent = `共 ${list.length} 个不可变版本：最新 v${list[list.length - 1].version}` +
      `（${new Date(list[list.length - 1].savedAt).toLocaleString()}）。` +
      (list.length < 2 ? '再保存一次即可比较两个版本。' : '选择两个版本后点“比较版本”。');
  }
  syncReviewBanner();
  syncReviewLocks();
}

/** 点击“比较版本”：拉取差异并进入较新版本的只读审阅。 */
async function compareVersions() {
  const sFrom = $('diffFrom');
  const sTo = $('diffTo');
  const fromV = Number(sFrom.value);
  const toV = Number(sTo.value);
  const st = $('versionStatus');
  if (!app.loadedId || !fromV || !toV || fromV === toV) {
    st.textContent = '请选择两个不同的版本进行比较。';
    return;
  }
  st.textContent = '正在比较版本…';
  try {
    // 版本允许任意顺序比较：展示统一以较早者为 A（from）、较晚者为 B（to）
    const lo = Math.min(fromV, toV);
    const hi = Math.max(fromV, toV);
    const resp = await fetch(`/api/plans/${encodeURIComponent(app.loadedId)}/diff?from=${lo}&to=${hi}`);
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error((data.error && data.error.message) || `HTTP ${resp.status}`);
    app.versions.diff = { fromV: lo, toV: hi, envelope: data, diff: data.diff };
    app.diffFocus = { cells: [], step: null, annoId: null };
    renderDiffList();
    // 进入较新版本的只读审阅（当前草稿压栈保存）
    await enterReview(hi);
  } catch (e) {
    st.textContent = '版本比较失败：' + e.message;
  }
}

function renderDiffList() {
  const state = app.versions.diff;
  const box = $('diffList');
  const sum = $('diffSummary');
  box.innerHTML = '';
  if (!state) { box.hidden = true; sum.hidden = true; return; }
  const { diff, fromV, toV } = state;
  const s = diff.summary;
  sum.hidden = false;
  const interruptedNote = diff.geometryInterrupted.from || diff.geometryInterrupted.to
    ? '（某一版本含非法折叠，几何比对按截断态进行）' : '';
  sum.innerHTML =
    `v${fromV} → v${toV}：共 <b>${s.total}</b> 项差异` +
    `（新增 ${s.adds} · 删除 ${s.removes} · 修改 ${s.changes}），` +
    `受影响原始纸格 <b>${s.affectedCells}</b> 个${interruptedNote}。` +
    `分类：步骤 ${s.byKind.step || 0} · 页码 ${s.byKind.label || 0} · ` +
    `批注 ${s.byKind.annotation || 0} · 标签备注 ${s.byKind.meta || 0} · ` +
    `爬移 ${s.byKind.creep || 0} · 网格 ${s.byKind.grid || 0}。`;
  box.hidden = false;
  if (!diff.changes.length) {
    box.innerHTML = '<li class="diff-empty">两个版本内容完全一致（无差异）。</li>';
    return;
  }
  diff.changes.forEach((ch, i) => box.appendChild(renderDiffItem(ch, i)));
}

const DIFF_KIND_NAME = {
  grid: '网格', meta: '标签/备注', step: '折叠步骤',
  label: '页码', annotation: '批注', creep: '爬移补偿'
};
const DIFF_OP_NAME = { add: '新增', remove: '删除', change: '修改' };

function renderDiffItem(ch, idx) {
  const li = document.createElement('li');
  li.className = `diff-item op-${ch.op} kind-${ch.kind}`;
  li.dataset.idx = String(idx);

  const head = document.createElement('div');
  const kind = document.createElement('span');
  kind.className = 'diff-kind k-' + ch.kind;
  kind.textContent = DIFF_KIND_NAME[ch.kind] || ch.kind;
  const op = document.createElement('span');
  op.className = 'diff-op op-' + ch.op;
  op.textContent = DIFF_OP_NAME[ch.op] || ch.op;
  const main = document.createElement('span');
  main.className = 'diff-main';
  main.innerHTML = diffItemTitle(ch);
  head.append(kind, op, main);
  li.appendChild(head);

  const detail = diffItemDetail(ch);
  if (detail) {
    const d = document.createElement('div');
    d.className = 'diff-detail';
    d.innerHTML = detail;
    li.appendChild(d);
  }
  if (ch.kind === 'annotation' && (ch.op === 'change' || ch.op === 'remove')) {
    const oldNew = document.createElement('div');
    oldNew.className = 'diff-old-new';
    oldNew.appendChild(diffAnnoLine(ch.from, 'diff-old'));
    if (ch.to) oldNew.appendChild(diffAnnoLine(ch.to, 'diff-new'));
    li.appendChild(oldNew);
  }

  // 联动操作：在旧版本 / 新版本中查看（步骤差异两侧均可点；页码/批注差异仅点存在侧）
  const actions = document.createElement('div');
  actions.className = 'diff-actions';
  const viewBtn = (version, text) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', () => viewChangeAt(idx, version));
    return b;
  };
  const existsFrom = ch.kind !== 'step' ? ch.op !== 'add' : !!ch.from;
  const existsTo = ch.kind !== 'step' ? ch.op !== 'remove' : !!ch.to;
  if (existsFrom) actions.appendChild(viewBtn(app.versions.diff.fromV, `在 v${app.versions.diff.fromV} 查看`));
  if (existsTo) actions.appendChild(viewBtn(app.versions.diff.toV, `在 v${app.versions.diff.toV} 查看`));
  li.appendChild(actions);
  return li;
}

function diffItemTitle(ch) {
  const faceText = (f) => f === 'front'
    ? '<span class="imp-face-front">正面</span>'
    : '<span class="imp-face-back">反面</span>';
  if (ch.kind === 'grid') {
    return `网格规格 ${ch.from.rows}×${ch.from.cols} → ${ch.to.rows}×${ch.to.cols}`;
  }
  if (ch.kind === 'meta') {
    if (ch.field === 'name') return `方案名称：${escapeHtml(ch.from || '（空）')} → ${escapeHtml(ch.to || '（空）')}`;
    if (ch.field === 'note') return `备注：${ch.op === 'add' ? '' : ch.op === 'remove' ? '' : ''}`
      + `<b>${ch.op === 'add' ? '新增备注' : ch.op === 'remove' ? '删除备注' : '备注修改'}</b>`;
    return `标签“${escapeHtml(ch.tag)}”${ch.op === 'add' ? '新增' : '移除'}`;
  }
  if (ch.kind === 'step') {
    return `第 ${ch.index + 1} 步` +
      (ch.op === 'add' ? `新增：${escapeHtml(ch.toText)}`
        : ch.op === 'remove' ? `删除：${escapeHtml(ch.fromText)}`
        : `修改：${escapeHtml(ch.fromText)} → ${escapeHtml(ch.toText)}`);
  }
  if (ch.kind === 'label') {
    const ogf = ch.outOfGridFrom ? '（旧网格之外）' : '';
    const ogt = ch.outOfGridTo ? '（新网格之外）' : '';
    const val = (v) => v == null ? '<span class="muted">不存在</span>'
      : v === '' ? '<span class="muted">空白</span>' : `“${escapeHtml(v)}”`;
    return `原格(${ch.cell}) · ${faceText(ch.face)}${ogf}${ogt}：${val(ch.from)} → ${val(ch.to)}`;
  }
  if (ch.kind === 'annotation') {
    const rec = ch.to || ch.from;
    const sevName = { error: '严重', warning: '警告', info: '建议' };
    const fieldsName = { cell: '原格', face: '面别', severity: '级别', text: '正文', resolved: '解决状态' };
    const why = ch.op === 'change'
      ? `（${ch.fields.map((f) => fieldsName[f] || f).join('、')}变化）` : '';
    return `${DIFF_OP_NAME[ch.op]}批注 · 原格(${rec.cell}) · ${faceText(rec.face)}` +
      ` · ${sevName[rec.severity] || rec.severity}${why}`;
  }
  if (ch.kind === 'creep') {
    const side = (s) => !s ? '无'
      : `纸厚 ${s.params && s.params.paperThickness} / 出血 ${s.params && s.params.bleed}` +
        `（${s.faceCount} 格，最大补偿 ${s.maxCompensation}）`;
    return `爬移补偿：${side(ch.from)} → ${side(ch.to)}`;
  }
  return '';
}

function diffItemDetail(ch) {
  if (ch.kind === 'meta' && ch.field === 'note') {
    return `<span class="diff-old">${ch.from ? '旧：' + escapeHtml(ch.from) : ''}</span>` +
      `<span class="diff-new">${ch.to ? '新：' + escapeHtml(ch.to) : ''}</span>`;
  }
  if (ch.kind === 'step') {
    const cells = (arr) => (arr || []).map((c) => `格(${c})`).join('、') || '—';
    return `受影响原始纸格：旧 ${cells(ch.fromCells)} ｜ 新 ${cells(ch.toCells)}`;
  }
  if (ch.kind === 'annotation') {
    const rec = ch.to || ch.from;
    return escapeHtml(rec.text || '');
  }
  if (ch.kind === 'creep' && ch.changedCells && ch.changedCells.length) {
    return `偏移变化的原始纸格：${ch.changedCells.map((c) => `格(${c})`).join('、')}`;
  }
  if (ch.kind === 'grid') {
    const list = (arr, name) => arr.length ? `${name}：${arr.map((c) => `格(${c})`).join('、')}` : '';
    return [list(ch.fromCells, '旧网格独有'), list(ch.toCells, '新网格独有')].filter(Boolean).join('；');
  }
  return '';
}

function diffAnnoLine(rec, cls) {
  const sev = { error: '严重', warning: '警告', info: '建议' };
  const span = document.createElement('div');
  span.className = cls;
  span.textContent = `${cls === 'diff-old' ? '旧' : '新'}：原格(${rec.cell}) · ` +
    `${rec.face === 'front' ? '正面' : '反面'} · ${sev[rec.severity] || rec.severity} · ` +
    `${rec.resolved ? '已解决' : '未解决'} · “${rec.text || ''}”`;
  return span;
}

/**
 * 点击差异行的“在 vN 查看”：载入该版本快照进入/切换只读审阅，
 * 并按差异类型联动回放（步骤→对应步；页码/批注→该原格并高亮）。
 */
async function viewChangeAt(changeIndex, version) {
  const ch = app.versions.diff.diff.changes[changeIndex];
  await enterReview(version);
  // 高亮当前差异行
  document.querySelectorAll('#diffList .diff-item').forEach((el) =>
    el.classList.toggle('diff-focus', Number(el.dataset.idx) === changeIndex));

  // 聚焦信息（按所在版本的纸格集合）
  const cells = ch.kind === 'step'
    ? (version === app.versions.diff.fromV ? ch.fromCells : ch.toCells)
    : (ch.cells || []);
  const inGrid = cells.filter((k) => {
    const [x, y] = k.split(',').map(Number);
    return x < app.plan.cols && y < app.plan.rows;
  });
  let step = null;
  let annoId = null;
  if (ch.kind === 'step') {
    // 新增步定位到执行后；删除步定位到该序号在旧版本中的状态
    step = Math.min(ch.index + (ch.op === 'remove' ? 0 : 1), app.plan.steps.length);
  } else if (ch.kind === 'label') {
    step = app.plan.steps.length;
  } else if (ch.kind === 'annotation') {
    const rec = ch.op === 'remove' ? ch.from : ch.to;
    annoId = rec.id;
    step = Math.min(rec.step, app.plan.steps.length);
  } else {
    // 网格 / 标签备注 / 爬移补偿：无具体回放步，定位到末态
    step = app.plan.steps.length;
  }
  app.diffFocus = { cells: inGrid, step, annoId, kind: ch.kind, index: ch.index };
  if (annoId) app.annotation.selectedId = annoId;
  setUpto(step == null ? app.plan.steps.length : step, true);
  $('saveMsg').textContent = `正在审阅 v${version}：${DIFF_KIND_NAME[ch.kind]}差异已定位` +
    (inGrid.length ? `，受影响纸格 ${inGrid.map((c) => `(${c})`).join('、')}。` : '。');
}

/** 审阅模式下点击画布纸格：若属于某条差异则定位到该差异。 */
function focusDiffAtCell(cellKey) {
  if (!app.versions.diff) return;
  // cellKey 是当前格位，反查其中的原始纸格是否落在某差异上
  const state = app.replay && app.replay.state;
  if (!state) return;
  const origins = (state.stacks[cellKey] || []).slice();
  const changes = app.versions.diff.diff.changes;
  for (let i = 0; i < changes.length; i++) {
    const ch = changes[i];
    const cells = ch.kind === 'step'
      ? (app.versions.review.version === app.versions.diff.fromV ? ch.fromCells : ch.toCells)
      : (ch.cells || []);
    if (origins.some((id) => cells.includes(id))) { viewChangeAt(i, app.versions.review.version); return; }
  }
  $('saveMsg').textContent = `格(${cellKey}) 中原始纸格 ${origins.map((o) => `(${o})`).join('、')} 在两版本间无差异。`;
}

/** 进入（或切换）历史版本只读审阅：首次进入时压栈当前草稿。 */
async function enterReview(version) {
  const planId = app.loadedId || app.versions.planId;
  if (!planId) return;
  try {
    const resp = await fetch(`/api/plans/${encodeURIComponent(planId)}/versions/${version}`);
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error((data.error && data.error.message) || `HTTP ${resp.status}`);

    const stash = app.versions.review
      ? app.versions.review.stash        // 已在审阅中切换版本：保留最初草稿
      : {
        plan: JSON.parse(JSON.stringify(app.plan)),
        upto: app.upto,
        loadedId: app.loadedId
      };

    const p = E.normalizePlan(data.plan);
    app.plan = p;
    app.annotation.editing = null;
    app.annotation.selectedId = null;
    hydratePlanForm(p);
    refreshLineSelect();
    app.versions.review = {
      version,
      savedAt: data.savedAt,
      reason: data.reason,
      restoredFromVersion: data.restoredFromVersion,
      stash
    };
    setUpto(p.steps.length, true);
    syncReviewBanner();
    syncReviewLocks();
    draw();
  } catch (e) {
    $('versionStatus').textContent = '历史版本载入失败：' + e.message;
  }
}

/** 退出版本审阅：恢复压栈的当前草稿。 */
function exitReview() {
  const review = app.versions.review;
  if (!review) return;
  const p = E.normalizePlan(review.stash.plan);
  app.plan = p;
  app.loadedId = review.stash.loadedId;
  app.annotation.editing = null;
  app.annotation.selectedId = null;
  app.versions.review = null;
  app.versions.diff = null;
  app.diffFocus = { cells: [], step: null, annoId: null };
  $('diffList').hidden = true;
  $('diffList').innerHTML = '';
  $('diffSummary').hidden = true;
  hydratePlanForm(p);
  refreshLineSelect();
  setUpto(Math.min(review.stash.upto, p.steps.length), true);  // 渲染恢复控件状态
  syncReviewBanner();
  $('saveMsg').textContent = '已返回当前草稿（历史版本未做任何改动）。';
}

/** 把审阅中的历史版本恢复为当前草稿：确认后退出审阅，历史不被覆盖。 */
function restoreReviewedVersion() {
  const review = app.versions.review;
  if (!review) return;
  const restoredFrom = review.version;
  if (!confirm(
    `将把历史版本 v${restoredFrom} 恢复为当前草稿。\n\n` +
    '· 历史版本为不可变快照，不会被覆盖或删除；\n' +
    '· 当前未保存的草稿内容将被该历史版本替换；\n' +
    '· 恢复后请使用“保存到服务器”沿既有流程保存——将产生新的版本号。\n\n' +
    '确认恢复？')) return;
  const p = JSON.parse(JSON.stringify(app.plan));
  app.loadedId = review.stash.loadedId;
  app.versions.review = null;
  app.versions.diff = null;
  app.diffFocus = { cells: [], step: null, annoId: null };
  app.versions.restoreMarker = restoredFrom;
  app.plan = E.normalizePlan(p);
  hydratePlanForm(app.plan);
  refreshLineSelect();
  $('diffList').hidden = true;
  $('diffList').innerHTML = '';
  $('diffSummary').hidden = true;
  syncReviewBanner();
  setUpto(app.plan.steps.length, true);
  $('saveMsg').textContent =
    `已把 v${restoredFrom} 恢复为当前草稿（历史保留不变）。检查无误后点“保存到服务器”生成新版本。`;
}

function syncReviewBanner() {
  const banner = $('reviewBanner');
  const review = app.versions.review;
  banner.hidden = !review;
  if (!review) return;
  const t = review.savedAt ? new Date(review.savedAt).toLocaleString() : '时间未知';
  const reason = review.reason === 'restore'
    ? `（该版本由恢复 v${review.restoredFromVersion || '?'} 后保存产生）` : '';
  $('reviewBannerText').innerHTML =
    `🔎 正在<b>只读审阅</b>不可变历史版本 <b>v${review.version}</b>（${t}）${reason}。<br>` +
    '编辑操作已锁定；可继续使用回放、面片轨迹、审计与双面版预览。' +
    '点差异行联动回放；完成后“返回当前草稿”，或把该版本“恢复为当前草稿”。';
}

/** 审阅模式下锁定全部方案变更控件（回放/筛选/只读卡片保持可用）。 */
const REVIEW_LOCK_IDS = [
  'createGridBtn',
  'delStepBtn', 'clearStepsBtn',
  'saveBtn', 'exportBtn', 'importBtn',
  'tagAddBtn', 'tagClearBtn',
  'imposePreviewBtn', 'imposeConfirmBtn',
  'pathSearchBtn',
  'creepApplyBtn', 'creepClearBtn',
  'annoSaveBtn', 'annoDeleteBtn',
  'deletePlanBtn'
];
const REVIEW_READONLY_IDS = [
  'planName', 'planNote', 'tagInput',
  'imposeStart', 'imposeCount',
  'creepThickness', 'creepBleed', 'annoText'
];

/**
 * 在每轮渲染之后应用审阅锁：锁定集合内控件强制 disabled / readOnly；
 * 解锁后不做任何处理——各卡片自身的渲染会按正常条件恢复启用状态。
 * 折叠四按钮通过 button.fold 集合单独处理。
 */
function applyReviewLock() {
  const locked = !!app.versions.review;
  // 未锁定时不干预：各卡片自身渲染按业务条件决定启用/禁用
  if (!locked) {
    $('diffLegend').hidden = true;
    return;
  }
  for (const id of REVIEW_LOCK_IDS) {
    const el = $(id);
    if (el) el.disabled = true;
  }
  document.querySelectorAll('button.fold').forEach((b) => { b.disabled = true; });
  for (const id of REVIEW_READONLY_IDS) {
    const el = $(id);
    if (el) el.readOnly = true;
  }
  $('diffLegend').hidden = !(app.versions.diff);
}

function syncReviewLocks() {
  applyReviewLock();
}

/** 当前差异高亮信息：受影响原始纸格集合（映射到当前版本格位）+ 聚焦集合。 */
function currentDiffMarks(state) {
  const dstate = app.versions.diff;
  if (!dstate || !state) return null;
  const reviewV = app.versions.review && app.versions.review.version;
  if (reviewV !== dstate.fromV && reviewV !== dstate.toV) return null;
  const isFrom = reviewV === dstate.fromV;
  const changed = new Set();
  for (const ch of dstate.diff.changes) {
    if (ch.kind === 'step') {
      (isFrom ? ch.fromCells : ch.toCells).forEach((c) => changed.add(c));
    } else {
      (ch.cells || []).forEach((c) => changed.add(c));
    }
  }
  // 末态几何变化（步骤增删导致位置/层序/朝向变化）也纳入
  const changedAtNow = new Set();
  const focusAtNow = new Set();
  const mapOrigin = (originSet, target) => {
    for (const id of originSet) {
      const p = state.panels[id];
      if (p) target.add(p.cx + ',' + p.cy);
    }
  };
  mapOrigin(changed, changedAtNow);
  // 未在变化条目中出现、但终态几何不同的原格
  for (const id of dstate.diff.affectedCells || []) {
    changed.add(id);
    const p = state.panels[id];
    if (p) changedAtNow.add(p.cx + ',' + p.cy);
  }
  const focusOrigins = new Set(app.diffFocus.cells || []);
  mapOrigin(focusOrigins, focusAtNow);
  // 当前格位 → 该格叠中受影响的原始纸格 id（用于按层描边）
  const affectedOriginByCell = new Map();
  for (const id of changed) {
    const p = state.panels[id];
    if (!p) continue;
    const at = p.cx + ',' + p.cy;
    if (!affectedOriginByCell.has(at)) affectedOriginByCell.set(at, new Set());
    affectedOriginByCell.get(at).add(id);
  }
  return { affectedOriginByCell, focusAtNow, isFrom };
}

init();

// 暴露给自动化检查（浏览器中无害）
if (typeof window !== 'undefined') {
  window.__foldApp = Object.assign(app, {
    requestStep, setUpto, createGrid, render, getFoldError: () => $('foldError'),
    applyPlan, planPayload,
    addTag, removeTag, clearTags, renderTagChips,
    loadList, renderPlanList,
    previewImposition, confirmImposition, closeImposition, renderImposition,
    readImposeInputs, runPathfind, doPathfindSearch, appendPathSolution, renderPathfind,
    renderTrack, refreshTrackCells, jumpTrackPoint, currentTrackInfo,
    openDuplex, closeDuplex, renderDuplex, renderDuplexPreview,
    renderCreep, computeCreep, applyCreep, clearCreep, creepSchemeStale,
    renderAudit, exportAudit,
    openAnnotationEditor, closeAnnotationEditor, commitAnnotation,
    deleteEditingAnnotation, setAnnotationResolved, deleteAnnotation,
    locateAnnotation, renderAnnotations, annotationLocations, currentAnnotationMarks,
    annotations,
    // 版本差异审阅
    refreshVersions, compareVersions, renderVersionCard, renderDiffList,
    fillVersionSelectors, enterReview, exitReview, restoreReviewedVersion,
    viewChangeAt, focusDiffAtCell, currentDiffMarks, resetVersionState,
    reviewGuard, applyReviewLock
  });
}
