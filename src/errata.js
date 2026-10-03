'use strict';

// 已发布版本勘误附记：编辑者对**指定已发布版本**快照中的事件或「先于」关系
// 登记勘误附记（该版快照对象编号 + 勘误说明 + 出处）。
//
// 数据层只在 version_errata 追加，**不改写任何历史快照
// （versions / version_events / version_relations）、求解日期或草稿**。
//
// 语义要点：
//
//   - 附记只属于目标版：以版本号维度登记，读出时仅附加到该目标版；
//     不随草稿恢复或以后发布的版本继承；
//   - 同一目标（version_no + target_type + target_id）只展示**编号最大**的
//     一条为生效附记；旧行不更新不删除，经 supersedes_id 串成替代链供追溯；
//   - 替代须提交所见附记号（expectedErratumId）；事务内与当前生效附记号
//     不符即 409 ERRATA_CONFLICT，响应携带当前附记全文，冲突方不落库；
//   - 版本不存在（404）、对象不存在 / 不属该版（422）、目标版已撤回（409
//     VERSION_RETRACTED）、说明或出处非法（400）均拒绝登记；
//   - 访客读出（最新年表、指定版本）附加生效附记，附记出处沿用现有精确
//     文本遮盖规则（命中登记文本显示「出处已遮盖」）；
//     持编辑口令的接口返回出处原文与替代链；
//   - 撤回后访客不再看到该版及其附记（公开读出层按版本过滤，本模块不改动）。

const { getDb } = require('./db');
const { latestVersionNo, getVersionDetail } = require('./publish');
const { isRetracted } = require('./retract');
const { REDACTED_SOURCE, redactedSourceSet } = require('./redact');

const MAX_CONTENT_LEN = 2000; // 勘误说明上限
const MAX_SOURCE_LEN = 1000; // 勘误出处上限（与出处录入一致）

// ---------- 入参规范化（非法即抛 400） ----------

function normalizeTargetType(targetType) {
  if (targetType !== 'event' && targetType !== 'relation') {
    throw { status: 400, message: 'targetType 必须是 "event"（事件）或 "relation"（先于关系）' };
  }
  return targetType;
}

function normalizeTargetId(targetId) {
  const id = Number(targetId);
  if (!Number.isInteger(id) || id < 1) {
    throw { status: 400, message: 'targetId 必须是该版快照中的正整数对象编号（事件 id 或关系 id）' };
  }
  return id;
}

function normalizeContent(content) {
  if (typeof content !== 'string') {
    throw { status: 400, message: 'content（勘误说明）必须是非空字符串' };
  }
  const text = content.trim();
  if (text === '') {
    throw { status: 400, message: '勘误说明不能为空：请说明该对象的勘误内容' };
  }
  if (text.length > MAX_CONTENT_LEN) {
    throw { status: 400, message: `勘误说明长度不能超过 ${MAX_CONTENT_LEN}` };
  }
  return text;
}

function normalizeSource(source) {
  if (typeof source !== 'string') {
    throw { status: 400, message: 'source（勘误出处）必须是非空字符串' };
  }
  const text = source.trim();
  if (text === '') {
    throw { status: 400, message: '勘误出处不能为空：请填写受访人 / 档案 / 页码等出处' };
  }
  if (text.length > MAX_SOURCE_LEN) {
    throw { status: 400, message: `勘误出处长度不能超过 ${MAX_SOURCE_LEN}` };
  }
  return text;
}

// expectedErratumId：所见生效附记号；null/省略/0 表示该目标尚无附记（首条）。
function normalizeExpectedId(value) {
  if (value === null || value === undefined) return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id < 0) {
    throw { status: 400, message: 'expectedErratumId 必须是所见生效附记的正整数编号，或省略表示首次登记' };
  }
  return id === 0 ? null : id;
}

function rowToApi(row) {
  if (!row) return null;
  return {
    erratumId: row.id,
    versionNo: row.version_no,
    targetType: row.target_type,
    targetId: row.target_id,
    content: row.content,
    source: row.source,
    editor: row.editor,
    supersedesErratumId: row.supersedes_id,
    createdAt: row.created_at,
  };
}

// ---------- 快照对象校验（只读） ----------

// 返回 { type:'event', title } / { type:'relation', earlierEventId, laterEventId }；
// 版本不存在返回 null；对象不在该版返回 undefined。
function findSnapshotObject(versionNo, targetType, targetId) {
  const db = getDb();
  if (targetType === 'event') {
    const row = db
      .prepare(
        `SELECT event_id AS eventId, title
           FROM version_events
          WHERE version_id = (SELECT id FROM versions WHERE version_no = ?)
            AND event_id = ?`
      )
      .get(versionNo, targetId);
    return row ? { type: 'event', title: row.title } : row;
  }
  const row = db
    .prepare(
      `SELECT relation_id AS relationId, earlier_event_id AS earlierEventId,
              later_event_id AS laterEventId
         FROM version_relations
        WHERE version_id = (SELECT id FROM versions WHERE version_no = ?)
          AND relation_id = ?`
    )
    .get(versionNo, targetId);
  return row
    ? { type: 'relation', earlierEventId: row.earlierEventId, laterEventId: row.laterEventId }
    : row;
}

// 目标描述（供 API 展示与编辑台定位）：附事件标题 / 关系两端事件标题。
function describeTarget(versionNo, targetType, targetId) {
  const found = findSnapshotObject(versionNo, targetType, targetId);
  if (targetType === 'event') {
    return { targetType: 'event', targetId, title: found ? found.title : null };
  }
  if (!found) {
    return { targetType: 'relation', targetId, earlierEventId: null, laterEventId: null, earlierTitle: null, laterTitle: null };
  }
  const titleOf = (eventId) => {
    const r = getDb()
      .prepare('SELECT title FROM version_events WHERE version_id = (SELECT id FROM versions WHERE version_no = ?) AND event_id = ?')
      .get(versionNo, eventId);
    return r ? r.title : null;
  };
  return {
    targetType: 'relation',
    targetId,
    earlierEventId: found.earlierEventId,
    laterEventId: found.laterEventId,
    earlierTitle: titleOf(found.earlierEventId),
    laterTitle: titleOf(found.laterEventId),
  };
}

// ---------- 登记 / 替代（事务内裁决，保证并发下只有一个替代成功） ----------
function createErratum({ versionNo, targetTypeRaw, targetIdRaw, content, source, expectedErratumIdRaw, editor = '' }) {
  const no = Number(versionNo);
  if (!Number.isInteger(no) || no < 1) {
    throw { status: 400, message: 'versionNo 必须是正整数（已发布版本号）' };
  }
  const targetType = normalizeTargetType(targetTypeRaw);
  const targetId = normalizeTargetId(targetIdRaw);
  const contentText = normalizeContent(content);
  const sourceText = normalizeSource(source);
  const expectedId = normalizeExpectedId(expectedErratumIdRaw);

  const db = getDb();

  // 事务前先做存在性 / 归属检查（抛 404/422）；撤回与并发裁决在事务内复查。
  const versionExists = db.prepare('SELECT 1 FROM versions WHERE version_no = ?').get(no);
  if (!versionExists) {
    throw { status: 404, message: `版本 ${no} 不存在，无法登记勘误附记` };
  }
  const found = findSnapshotObject(no, targetType, targetId);
  if (!found) {
    const kind = targetType === 'event' ? `事件（快照编号 ${targetId}）` : `「先于」关系（快照编号 ${targetId}）`;
    throw {
      status: 422,
      code: 'ERRATA_TARGET_NOT_IN_VERSION',
      message: `目标对象不属于第 ${no} 版：该版快照中找不到${kind}，请核对该版快照中的对象编号`,
      versionNo: no,
      targetType,
      targetId,
    };
  }

  let createdRow = null;
  let previousRow = null;
  let currentRow = null;
  let conflict = false;

  const tx = db.transaction(() => {
    // 目标版已撤回 → 拒绝登记（事务内复查，避免与撤回竞争）
    if (isRetracted(no)) {
      throw {
        status: 409,
        code: 'VERSION_RETRACTED',
        message: `第 ${no} 版已撤回，不能再登记勘误附记；请在修正后的新版本上登记`,
        versionNo: no,
      };
    }

    // 该目标当前生效附记 = 编号最大的一条（替代链只追加，链头即最新）
    const latest = db
      .prepare(
        `SELECT * FROM version_errata
          WHERE version_no = ? AND target_type = ? AND target_id = ?
          ORDER BY id DESC LIMIT 1`
      )
      .get(no, targetType, targetId);
    const latestId = latest ? latest.id : null;

    if ((expectedId || null) !== (latestId || null)) {
      // 乐观并发失败：两个编辑者同时替代时仅一个成功；冲突方取得当前附记且不落库
      conflict = true;
      currentRow = latest;
      return;
    }

    const info = db
      .prepare(
        `INSERT INTO version_errata
           (version_no, target_type, target_id, content, source, editor, supersedes_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(no, targetType, targetId, contentText, sourceText, String(editor || ''), latestId);
    createdRow = db.prepare('SELECT * FROM version_errata WHERE id = ?').get(info.lastInsertRowid);
    previousRow = latest;
  });
  tx();

  if (conflict) {
    throw {
      status: 409,
      code: 'ERRATA_CONFLICT',
      message:
        currentRow && expectedId === null
          ? `登记冲突：该目标已被他人先登记了附记 ${currentRow.id}，请取得当前附记后以其编号为所见附记号替代`
          : `勘误附记已被他人更新：你提交的所见附记号为 ${expectedId === null ? '空（首条）' : expectedId}，当前生效附记为 ${currentRow ? currentRow.id : '空（已无生效附记）'}。请取得当前附记后重试`,
      versionNo: no,
      target: { targetType, targetId, ...describeTarget(no, targetType, targetId) },
      expectedErratumId: expectedId,
      currentErratum: rowToApi(currentRow), // 冲突方取得当前附记（原文），不落库
    };
  }

  return {
    ok: true,
    erratum: rowToApi(createdRow),
    previousErratum: rowToApi(previousRow), // 被替代的旧附记（首条为 null）
    currentVersionNo: latestVersionNo(),
  };
}

// ---------- 读出：某版本全部生效附记（每目标编号最大的一条） ----------

function activeErratumRows(versionNo) {
  return getDb()
    .prepare(
      `SELECT e.* FROM version_errata e
        JOIN (SELECT target_type AS tt, target_id AS tid, MAX(id) AS max_id
                FROM version_errata WHERE version_no = ?
               GROUP BY target_type, target_id) m
          ON e.target_type = m.tt AND e.target_id = m.tid AND e.id = m.max_id
       WHERE e.version_no = ?
       ORDER BY e.target_type, e.target_id, e.id`
    )
    .all(versionNo, versionNo);
}

// 给附记补目标描述（标题等，便于访客页直接展示）。
function withTarget(versionNo, e) {
  const db = getDb();
  if (e.targetType === 'event') {
    const row = db
      .prepare('SELECT title FROM version_events WHERE version_id = (SELECT id FROM versions WHERE version_no = ?) AND event_id = ?')
      .get(versionNo, e.targetId);
    return { ...e, title: row ? row.title : null };
  }
  const row = db
    .prepare(
      `SELECT earlier_event_id AS eid, later_event_id AS lid
         FROM version_relations
        WHERE version_id = (SELECT id FROM versions WHERE version_no = ?) AND relation_id = ?`
    )
    .get(versionNo, e.targetId);
  const titleOf = (eventId) => {
    const r = db
      .prepare('SELECT title FROM version_events WHERE version_id = (SELECT id FROM versions WHERE version_no = ?) AND event_id = ?')
      .get(versionNo, eventId);
    return r ? r.title : null;
  };
  return {
    ...e,
    earlierEventId: row ? row.eid : null,
    laterEventId: row ? row.lid : null,
    earlierTitle: row ? titleOf(row.eid) : null,
    laterTitle: row ? titleOf(row.lid) : null,
  };
}

// 编辑者视角：某版本生效附记（出处原文，附目标描述）。撤回版同样可读。
function listActiveErrataForVersion(versionNo) {
  return activeErratumRows(versionNo).map((r) => withTarget(versionNo, rowToApi(r)));
}

// 公开读出层：把生效附记附加到版本详情；附记出处命中遮盖登记时显示「出处已遮盖」。
// 由调用方保证该版本未撤回（撤回版在公开路由层直接 404，不会进入本函数）。
function attachErrataToPublicVersion(version) {
  if (!version) return version;
  const redactedSet = redactedSourceSet();
  const errata = activeErratumRows(version.versionNo).map((r) => {
    const e = withTarget(version.versionNo, rowToApi(r));
    return { ...e, source: redactedSet.has(e.source) ? REDACTED_SOURCE : e.source };
  });
  return { ...version, errata };
}

// 单条附记的替代链（含该条本身，按登记先后排列）；不存在返回 null。
function getErratumChain(erratumId) {
  const db = getDb();
  const start = db.prepare('SELECT * FROM version_errata WHERE id = ?').get(Number(erratumId));
  if (!start) return null;
  // 先沿 supersedes_id 回到链首，再按 id 升序收集同目标的全部记录（链即同目标所有行）
  const chain = db
    .prepare(
      `SELECT * FROM version_errata
        WHERE version_no = ? AND target_type = ? AND target_id = ?
       ORDER BY id`
    )
    .all(start.version_no, start.target_type, start.target_id)
    .map((r) => rowToApi(r))
    .map((e) => withTarget(start.version_no, e));
  return {
    versionNo: start.version_no,
    target: describeTarget(start.version_no, start.target_type, start.target_id),
    activeErratumId: chain.length ? chain[chain.length - 1].erratumId : null,
    chain,
  };
}

// 取单条附记（编辑者查阅原文用）。
function getErratum(erratumId) {
  const row = getDb().prepare('SELECT * FROM version_errata WHERE id = ?').get(Number(erratumId));
  if (!row) return null;
  return withTarget(row.version_no, rowToApi(row));
}

// 全部附记（编辑者清单 / 编辑台），按版本号与登记顺序；可按版本过滤。
function listAllErrata(versionNo = null) {
  const db = getDb();
  const rows = versionNo === null
    ? db.prepare('SELECT * FROM version_errata ORDER BY version_no, target_type, target_id, id').all()
    : db
        .prepare('SELECT * FROM version_errata WHERE version_no = ? ORDER BY target_type, target_id, id')
        .all(Number(versionNo));
  return rows.map((r) => withTarget(r.version_no, rowToApi(r)));
}

module.exports = {
  MAX_CONTENT_LEN,
  MAX_SOURCE_LEN,
  createErratum,
  activeErratumRows,
  listActiveErrataForVersion,
  attachErrataToPublicVersion,
  getErratum,
  getErratumChain,
  listAllErrata,
  findSnapshotObject,
};
