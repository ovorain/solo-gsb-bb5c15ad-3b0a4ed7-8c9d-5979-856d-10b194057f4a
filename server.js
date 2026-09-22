'use strict';
/**
 * server.js —— 折页阅读顺序校样 Web 服务
 *  - 静态托管 public/（原生 HTML/CSS/Canvas 前端）
 *  - /api/simulate：服务端重放方案（与浏览器共用同一份 foldEngine.js）
 *  - /api/audit：生产质量审计（只读，不改动方案）
 *  - /api/creep-compensation：书帖爬移补偿逐叶偏移（只读计算）
 *  - /api/annotations/locate：校样批注按原始面片身份定位到指定回放步（只读）
 *  - /api/plans* ：方案 JSON 持久化到 DATA_DIR（容器卷，含标签/备注/校样批注）
 *  - 版本差异审阅：每次成功保存写入不可变快照（DATA_DIR/<id>.versions/），
 *    GET /api/plans/:id/versions、/versions/:version、/diff（只读）
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./public/foldEngine.js');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// ---------- 方案标签 / 备注约束（与浏览器共用 foldEngine 中的严格规整） ----------
const { MAX_TAGS, MAX_TAG_LEN, MAX_NOTE_LEN, MAX_NAME_LEN } = E.META_LIMITS;
const TAG_FORBIDDEN_RE = /[\p{C},;|]/u;

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 模拟 ----------
app.post('/api/simulate', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const upto = req.body && Number.isInteger(req.body.upto)
      ? Math.max(0, Math.min(req.body.upto, plan.steps.length))
      : plan.steps.length;
    const { state, error } = E.replay(plan.rows, plan.cols, plan.labels, plan.steps, upto);
    res.json({
      ok: !error,
      upto,
      error: error || null,
      stacks: E.pageSequence(state).stacks,
      folded: E.pageSequence(state).folded,
      occupied: Object.keys(state.stacks).map((k) => {
        const [x, y] = k.split(',').map(Number);
        return {
          x, y, depth: state.stacks[k].length,
          panels: state.stacks[k].map((id) => {
            const p = state.panels[id];
            return {
              id, ox: p.ox, oy: p.oy, cx: p.cx, cy: p.cy,
              frame: p.frame,
              front: p.front, back: p.back
            };
          })
        };
      })
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 自动拼版 ----------
app.post('/api/impose', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const result = E.autoImpose(
      plan.rows, plan.cols, plan.labels, plan.steps,
      req.body && req.body.startPage,
      req.body && req.body.pageCount
    );
    if (!result.ok) {
      return res.json({
        ok: false,
        error: {
          code: result.code,
          message: result.message,
          capacity: result.capacity,
          stepIndex: result.stepIndex,
          conflicts: result.conflicts,
          stackCount: result.stackCount
        }
      });
    }
    res.json({
      ok: true,
      startPage: result.startPage,
      pageCount: result.pageCount,
      capacity: result.capacity,
      blankTrailing: result.blankTrailing,
      labels: result.labels,
      slots: result.slots,
      overwrites: E.impositionOverwrite(plan.labels, result)
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 双面印刷版预览 ----------
app.post('/api/duplex-plate', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const result = E.buildDuplexPlates(
      plan.rows, plan.cols, plan.labels, plan.steps,
      req.body && req.body.flip
    );
    if (!result.ok) {
      return res.json({
        ok: false,
        error: {
          code: result.code,
          message: result.message,
          capacity: result.capacity,
          stepIndex: result.stepIndex,
          conflicts: result.conflicts,
          stackCount: result.stackCount
        }
      });
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 折手自动寻路 ----------
app.post('/api/find-path', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const optsRaw = req.body && req.body.options && typeof req.body.options === 'object'
      ? req.body.options : {};
    const result = E.findFoldPath(
      plan.rows, plan.cols, plan.labels, plan.steps,
      req.body && req.body.target,
      {
        // 服务端硬性兜底：最多 8 步、2 秒
        maxDepth: Math.min(8, Math.max(0, Number(optsRaw.maxDepth) || 8)),
        timeoutMs: Math.min(2000, Math.max(1, Number(optsRaw.timeoutMs) || 2000))
      }
    );
    if (!result.ok) {
      return res.json({
        ok: false,
        error: {
          code: result.code,
          message: result.message,
          rows: result.rows, cols: result.cols,
          stepIndex: result.stepIndex,
          conflicts: result.conflicts
        }
      });
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 面片轨迹 ----------
app.post('/api/trajectory', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const result = E.trackPanel(
      plan.rows, plan.cols, plan.labels, plan.steps,
      req.body && req.body.target
    );
    if (!result.ok) {
      return res.json({ ok: false, error: { code: result.code, message: result.message } });
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 生产质量审计（只读） ----------
app.post('/api/audit', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const result = E.auditPlan(plan.rows, plan.cols, plan.labels, plan.steps);
    if (!result.ok) {
      return res.json({
        ok: false,
        error: {
          code: result.code,
          message: result.message,
          stepIndex: result.stepIndex,
          conflicts: result.conflicts
        }
      });
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 书帖爬移补偿 ----------
app.post('/api/creep-compensation', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const result = E.creepCompensation(
      plan.rows, plan.cols, plan.labels, plan.steps,
      req.body && req.body.paperThickness,
      req.body && req.body.bleed
    );
    if (!result.ok) {
      return res.json({
        ok: false,
        error: {
          code: result.code,
          message: result.message,
          capacity: result.capacity,
          stepIndex: result.stepIndex,
          conflicts: result.conflicts,
          stackCount: result.stackCount
        }
      });
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 校样批注定位（只读） ----------
app.post('/api/annotations/locate', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const rawAnnos = (req.body && Array.isArray(req.body.annotations))
      ? req.body.annotations : plan.annotations;
    // 定位接口只读：批注做宽容规整即可，绝不因外部 JSON 的坏条目整体失败
    const annotations = E.coerceAnnotations(rawAnnos, plan.rows, plan.cols, plan.steps);
    const upto = req.body && Number.isInteger(req.body.upto)
      ? Math.max(0, Math.min(req.body.upto, plan.steps.length))
      : plan.steps.length;
    const result = E.locateAnnotations(
      plan.rows, plan.cols, plan.labels, plan.steps, upto, annotations);
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 方案持久化 ----------
function planFile(id) { return path.join(DATA_DIR, `${id}.json`); }

/**
 * ---------- 不可变版本快照 ----------
 * 每次成功保存方案后，把本次规范化方案完整写入
 *   DATA_DIR/<id>.versions/v000006.json（6 位零填序号，从 1 起）。
 * 快照只追加、永不原地改写：恢复历史版本也只是把它载入为当前草稿，
 * 下一次保存产生新序号，历史保持完整。
 */
function versionsDir(id) { return path.join(DATA_DIR, `${id}.versions`); }
function versionFile(id, version) {
  return path.join(versionsDir(id), `v${String(version).padStart(6, '0')}.json`);
}
const VERSION_FILE_RE = /^v(\d{6})\.json$/;

/** 读取某方案全部版本（序号升序）；损坏快照跳过。 */
function readVersions(id) {
  const dir = versionsDir(id);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const m = VERSION_FILE_RE.exec(f);
    if (!m) continue;
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push(snapshotSummary(snap, Number(m[1])));
    } catch { /* 损坏快照跳过，不影响其它版本 */ }
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}

/** 版本摘要（列表用）：不返回完整 labels/steps/annotations。 */
function snapshotSummary(snap, version) {
  const p = snap.plan || {};
  const annos = Array.isArray(p.annotations) ? p.annotations : [];
  return {
    version,
    planId: snap.planId,
    name: p.name || '未命名方案',
    rows: p.rows, cols: p.cols,
    steps: Array.isArray(p.steps) ? p.steps.length : 0,
    tags: Array.isArray(p.tags) ? p.tags : [],
    note: typeof p.note === 'string' ? p.note : '',
    annotations: annos.length,
    openAnnotations: annos.reduce((n, a) => n + (a && a.resolved !== true ? 1 : 0), 0),
    hasCreep: !!p.creepCompensation,
    savedAt: typeof snap.savedAt === 'string' ? snap.savedAt : null,
    reason: snap.reason === 'restore' ? 'restore' : 'save',
    restoredFromVersion: Number.isInteger(snap.restoredFromVersion) ? snap.restoredFromVersion : null
  };
}

/** 追加不可变快照：按目录中最大序号 + 1 原子写入，返回版本号与摘要。 */
function appendVersionSnapshot(id, plan, reason, fromVersion) {
  const dir = versionsDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const nextVersion = readVersions(id).reduce((m, v) => Math.max(m, v.version), 0) + 1;
  const now = new Date().toISOString();
  const snap = {
    version: nextVersion,
    planId: id,
    reason: reason === 'restore' ? 'restore' : 'save',
    savedAt: now,
    plan
  };
  if (reason === 'restore' && Number.isInteger(fromVersion) && fromVersion > 0) {
    snap.restoredFromVersion = fromVersion;
  }
  const tmp = path.join(dir, `.v${String(nextVersion).padStart(6, '0')}.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
  fs.renameSync(tmp, versionFile(id, nextVersion));
  return { version: nextVersion, savedAt: now };
}

/** 读取单个版本快照（不存在返回 null）。 */
function readVersionSnapshot(id, version) {
  const f = versionFile(id, version);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/**
 * 方案元信息严格校验：直接委托浏览器/服务端共用的 E.normalizePlanMeta，
 * 错误带 code（bad_name/name_too_long/bad_tags/tag_too_long/tag_forbidden/
 * too_many_tags/bad_note/note_too_long），由 POST 处理器整请求拒绝。
 */
function normalizePlanMeta(body) {
  try {
    return E.normalizePlanMeta(body);
  } catch (e) {
    if (e instanceof E.MetaError) {
      const err = new Error(e.message);
      err.code = e.code;
      throw err;
    }
    throw e;
  }
}

/**
 * 校样批注严格校验：委托 foldEngine.normalizeAnnotations，
 * 错误带 code（bad_annotations/bad_annotation/bad_annotation_id/
 * duplicate_annotation_id/bad_annotation_cell/bad_annotation_face/
 * bad_annotation_severity/bad_annotation_text/annotation_too_long/
 * annotation_control_chars/bad_annotation_step/bad_annotation_resolved/
 * too_many_annotations），由 POST 处理器整请求拒绝。
 */
function normalizeAnnotations(body, plan) {
  try {
    return E.normalizeAnnotations(body.annotations, {
      rows: plan.rows, cols: plan.cols, steps: plan.steps
    });
  } catch (e) {
    if (e instanceof E.AnnotationError) {
      const err = new Error(e.message);
      err.code = e.code;
      throw err;
    }
    throw e;
  }
}

/** 解析标签交集查询参数：英文逗号（或分号）分隔，逐项 trim，空项/重复忽略；非法项抛错。 */
function parseTagFilter(raw) {
  if (raw == null || raw === '') return [];
  if (typeof raw !== 'string') throw badFilter('标签筛选参数格式非法。');
  const out = [];
  const seen = new Set();
  for (let part of raw.split(/[,;]/)) {
    part = part.trim();
    if (!part) continue;
    if ([...part].length > MAX_TAG_LEN || TAG_FORBIDDEN_RE.test(part)) {
      throw badFilter(`筛选标签非法：“${part}”。`);
    }
    if (!seen.has(part)) { seen.add(part); out.push(part); }
  }
  return out;
}

function badFilter(message) {
  const err = new Error(message);
  err.code = 'bad_tag_filter';
  return err;
}

/** 读取全部存档摘要（含标签/备注/时间戳）；损坏文件跳过。 */
function readAllPlans() {
  return fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const filePath = path.join(DATA_DIR, f);
        const p = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const st = fs.statSync(filePath);
        const id = f.replace(/\.json$/, '');
        const updatedAt = typeof p.updatedAt === 'string' ? p.updatedAt : new Date(st.mtimeMs).toISOString();
        const annos = Array.isArray(p.annotations) ? p.annotations : [];
        return {
          id,
          name: p.name || '未命名方案',
          rows: p.rows, cols: p.cols,
          steps: Array.isArray(p.steps) ? p.steps.length : 0,
          tags: Array.isArray(p.tags) ? p.tags : [],
          note: typeof p.note === 'string' ? p.note : '',
          annotations: annos.length,
          openAnnotations: annos.reduce((n, a) => n + (a && a.resolved !== true ? 1 : 0), 0),
          versions: fs.existsSync(path.join(DATA_DIR, `${id}.versions`))
            ? readVersions(id).length : 0,
          createdAt: typeof p.createdAt === 'string' ? p.createdAt : updatedAt,
          updatedAt
        };
      } catch { return null; }
    })
    .filter(Boolean);
}

/**
 * GET /api/plans：方案存档列表，支持
 *  - tags：标签交集（英文逗号/分号分隔，须全部命中）
 *  - q：名称关键词（大小写不敏感子串）
 *  - since：仅返回该时间（ISO 字符串或毫秒数）之后更新的存档
 * 返回 { total, matched, items, allTags }；排序为更新时间倒序，同时间按 id 升序（稳定）。
 */
app.get('/api/plans', (req, res) => {
  let tagFilter, q, since;
  try {
    // express 默认 qs 查询解析会把纯数字值解析成 number，统一转字符串处理
    const tagsRaw = req.query.tags == null ? '' : String(req.query.tags);
    const sinceRaw = req.query.since == null ? '' : String(req.query.since);
    tagFilter = parseTagFilter(tagsRaw);
    q = typeof req.query.q === 'string' ? req.query.q.trim() : String(req.query.q || '').trim();
    if (sinceRaw !== '') {
      const n = Number(sinceRaw);
      since = Number.isFinite(n) ? new Date(n) : new Date(sinceRaw);
      if (isNaN(since.getTime())) {
        return res.status(400).json({
          ok: false, error: { code: 'bad_since', message: 'since 必须为合法时间（ISO 字符串或毫秒数）。' }
        });
      }
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: { code: e.code || 'bad_filter', message: e.message } });
  }

  const all = readAllPlans();
  const total = all.length;

  // 全部存档的标签聚合（不受筛选影响）：按出现次数倒序、同次数按标签升序
  const tagCounts = new Map();
  for (const it of all) for (const t of it.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const allTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([tag, count]) => ({ tag, count }));

  const ql = q.toLowerCase();
  const sinceMs = since ? since.getTime() : null;
  const items = all
    .filter((it) => tagFilter.every((t) => it.tags.includes(t)))
    .filter((it) => !ql || it.name.toLowerCase().includes(ql))
    .filter((it) => sinceMs == null || new Date(it.updatedAt).getTime() >= sinceMs)
    .sort((a, b) => {
      const dt = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      return dt !== 0 ? dt : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });

  res.json({ total, matched: items.length, items, allTags });
});

app.post('/api/plans', (req, res) => {
  // 先完成全部校验，再触碰文件系统：非法请求绝不改动任何已有存档
  let plan, meta, annotations;
  try {
    plan = E.normalizePlan(req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
  try {
    meta = normalizePlanMeta(req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: { code: e.code, message: e.message } });
  }
  try {
    // 批注严格校验基于<b>原始提交</b>的数据（而非宽容规整后的 plan），
    // 任何坏条目都让整请求被拒绝，不静默改写用户内容。
    annotations = normalizeAnnotations(req.body || {}, plan);
  } catch (e) {
    return res.status(400).json({ ok: false, error: { code: e.code, message: e.message } });
  }

  const id = (req.body && typeof req.body.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(req.body.id))
    ? req.body.id : crypto.randomBytes(6).toString('hex');
  const now = new Date().toISOString();
  const existingPath = planFile(id);
  let createdAt = now;
  if (fs.existsSync(existingPath)) {
    try {
      const old = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
      if (typeof old.createdAt === 'string') createdAt = old.createdAt;
    } catch { /* 损坏旧档：以新时间为准 */ }
  }

  const body = {
    name: meta.name, rows: plan.rows, cols: plan.cols,
    labels: plan.labels, steps: plan.steps,
    tags: meta.tags, note: meta.note,
    annotations,
    createdAt, updatedAt: now,
    savedAt: now
  };
  // 爬移补偿独立方案字段：存在则随存档保留（GET /api/plans/:id 原样返回）
  if (plan.creepCompensation) body.creepCompensation = plan.creepCompensation;

  // 原子写入：先写临时文件（非 .json 名，不会被列表扫描读到）再 rename，失败不会留下半截存档
  const tmp = path.join(DATA_DIR, `.${id}.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, existingPath);

  // 本次保存成功 → 追加不可变版本快照（只追加，永不原地改写；恢复历史后保存另起新版本）
  const restoreFrom = Number.isInteger(req.body && req.body.restoredFromVersion)
    ? req.body.restoredFromVersion : null;
  const { version, savedAt } = appendVersionSnapshot(
    id, body, restoreFrom ? 'restore' : 'save', restoreFrom);

  res.json({ ok: true, id, version, savedAt, plan: body });
});

app.get('/api/plans/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return res.status(400).json({ ok: false, error: { message: '非法 id' } });
  const f = planFile(id);
  if (!fs.existsSync(f)) return res.status(404).json({ ok: false, error: { message: '方案不存在' } });
  res.type('application/json').send(fs.readFileSync(f, 'utf8'));
});

app.delete('/api/plans/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return res.status(400).json({ ok: false, error: { message: '非法 id' } });
  const f = planFile(id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  // 一并删除不可变版本目录（删方案即删全部历史，与命名卷内文件清理一致）
  fs.rmSync(versionsDir(id), { recursive: true, force: true });
  res.json({ ok: true });
});

// ---------- 版本差异审阅（只读） ----------
/**
 * GET /api/plans/:id/versions：不可变版本列表（序号升序）。
 * 响应 { ok, id, latest, versions:[{version,name,rows,cols,steps,tags,note,
 *   annotations,openAnnotations,hasCreep,savedAt,reason,restoredFromVersion}] }。
 */
app.get('/api/plans/:id/versions', (req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    return res.status(400).json({ ok: false, error: { code: 'bad_id', message: '非法 id' } });
  }
  if (!fs.existsSync(planFile(id))) {
    return res.status(404).json({ ok: false, error: { code: 'not_found', message: '方案不存在' } });
  }
  const versions = readVersions(id);
  res.json({ ok: true, id, latest: versions.length ? versions[versions.length - 1].version : 0, versions });
});

/**
 * GET /api/plans/:id/versions/:version：单个不可变版本的完整快照。
 * 返回 { ok, version, reason, restoredFromVersion, savedAt, plan }。
 */
app.get('/api/plans/:id/versions/:version', (req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    return res.status(400).json({ ok: false, error: { code: 'bad_id', message: '非法 id' } });
  }
  const v = Number(req.params.version);
  if (!Number.isInteger(v) || v < 1) {
    return res.status(400).json({ ok: false, error: { code: 'bad_version', message: '版本号须为不小于 1 的整数。' } });
  }
  if (!fs.existsSync(planFile(id))) {
    return res.status(404).json({ ok: false, error: { code: 'not_found', message: '方案不存在' } });
  }
  const snap = readVersionSnapshot(id, v);
  if (!snap) {
    return res.status(404).json({ ok: false, error: { code: 'version_not_found', message: `版本 v${v} 不存在。` } });
  }
  res.json({
    ok: true,
    version: snap.version,
    reason: snap.reason === 'restore' ? 'restore' : 'save',
    restoredFromVersion: Number.isInteger(snap.restoredFromVersion) ? snap.restoredFromVersion : null,
    savedAt: snap.savedAt,
    plan: snap.plan
  });
});

/**
 * GET /api/plans/:id/diff?from=&to=：以原始纸格与步骤序号为稳定身份
 * 比较两个不可变版本（页码 / 折叠步骤 / 标签备注 / 校样批注 / 爬移补偿的增删改）。
 * 响应包裹引擎 diffPlans：{ ok, id, from:{version,savedAt}, to:{...}, diff }。
 */
app.get('/api/plans/:id/diff', (req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    return res.status(400).json({ ok: false, error: { code: 'bad_id', message: '非法 id' } });
  }
  if (!fs.existsSync(planFile(id))) {
    return res.status(404).json({ ok: false, error: { code: 'not_found', message: '方案不存在' } });
  }
  const fromV = Number(req.query.from);
  const toV = Number(req.query.to);
  if (!Number.isInteger(fromV) || fromV < 1 || !Number.isInteger(toV) || toV < 1) {
    return res.status(400).json({
      ok: false,
      error: { code: 'bad_version', message: 'from / to 均须为不小于 1 的版本号整数。' }
    });
  }
  if (fromV === toV) {
    return res.status(400).json({
      ok: false,
      error: { code: 'bad_version', message: '请选择两个不同的版本进行比较（from ≠ to）。' }
    });
  }
  const snapF = readVersionSnapshot(id, fromV);
  const snapT = readVersionSnapshot(id, toV);
  if (!snapF || !snapT) {
    return res.status(404).json({
      ok: false,
      error: {
        code: 'version_not_found',
        message: `版本 v${!snapF ? fromV : toV} 不存在。`
      }
    });
  }
  let diff;
  try {
    diff = E.diffPlans(snapF.plan, snapT.plan);
  } catch (e) {
    return res.status(400).json({ ok: false, error: { code: 'bad_snapshot', message: e.message } });
  }
  res.json({
    ok: true,
    id,
    from: { version: snapF.version, savedAt: snapF.savedAt },
    to: { version: snapT.version, savedAt: snapT.savedAt },
    diff
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`折页阅读顺序校样应用已启动： http://localhost:${PORT}`);
  });
}

module.exports = app;
module.exports.normalizePlanMeta = normalizePlanMeta;
module.exports.normalizeAnnotations = normalizeAnnotations;
module.exports.parseTagFilter = parseTagFilter;
module.exports.limits = { MAX_TAGS, MAX_TAG_LEN, MAX_NOTE_LEN, MAX_NAME_LEN };
