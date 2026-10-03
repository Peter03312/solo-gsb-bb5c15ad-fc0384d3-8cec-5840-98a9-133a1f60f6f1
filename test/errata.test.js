'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');
const { REDACTED_SOURCE } = require('../src/redact');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM version_errata;
    DELETE FROM version_retractions;
    DELETE FROM source_redactions;
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0;
  `);
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function makeEvent(title) {
  const r = await call('POST', '/api/editor/events', { body: { title } });
  assert.strictEqual(r.status, 201);
  return r.json.event.id;
}

async function makeClaim(eventId, payload) {
  const r = await call('POST', `/api/editor/events/${eventId}/claims`, { body: payload });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.claim.id;
}

async function makeRel(earlierId, laterId, source = '') {
  const r = await call('POST', '/api/editor/relations', { body: { earlierId, laterId, source } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}

async function publish(selection, baseVersionNo, note) {
  const r = await call('POST', '/api/editor/publish', { body: { selection, baseVersionNo, note } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.versionNo;
}

// 标准两事件一关系草稿并发布第 1 版；返回快照对象编号
async function scenarioV1() {
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: '李宝山口述' });
  const c2 = await makeClaim(e2, { precision: 'year', year: 1959, source: '县水利志 87 页' });
  const rel = await makeRel(e1, e2, '二人一致');
  const no = await publish(
    [
      { eventId: e1, claimId: c1 },
      { eventId: e2, claimId: c2 },
    ],
    0
  );
  assert.strictEqual(no, 1);
  return { e1, e2, c1, c2, rel };
}

const erratumBody = (targetType, targetId, extra = {}) => ({
  targetType,
  targetId,
  content: '日期应为 1959 年春',
  source: '县档案馆全宗 03 第 12 页',
  editor: '志愿者小王',
  ...extra,
});

// ---------- 登记 ----------

test('为已发布版快照事件登记勘误附记：201，旧快照与求解日期不变', async () => {
  const { e1 } = await scenarioV1();
  const before = await call('GET', `/api/editor/versions/1/raw`);
  const r = await call('POST', '/api/editor/versions/1/errata', {
    body: erratumBody('event', e1),
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.erratum.erratumId, 1);
  assert.strictEqual(r.json.erratum.versionNo, 1);
  assert.strictEqual(r.json.erratum.targetType, 'event');
  assert.strictEqual(r.json.erratum.targetId, e1);
  assert.strictEqual(r.json.erratum.content, '日期应为 1959 年春');
  assert.strictEqual(r.json.erratum.supersedesErratumId, null);
  assert.strictEqual(r.json.previousErratum, null);
  assert.ok(r.json.erratum.createdAt);

  // 快照原文（标题/出处/求解日期）一字未改
  const after = await call('GET', '/api/editor/versions/1/raw');
  assert.deepStrictEqual(after.json.version.events, before.json.version.events);
  assert.deepStrictEqual(after.json.version.relations, before.json.version.relations);

  // 原文视图附带该版生效附记（出处原文）
  assert.strictEqual(after.json.activeErrata.length, 1);
  assert.strictEqual(after.json.activeErrata[0].source, '县档案馆全宗 03 第 12 页');
  assert.strictEqual(after.json.activeErrata[0].title, '动员会');
});

test('为「先于」关系登记附记，目标描述带两端事件标题', async () => {
  const { rel } = await scenarioV1();
  const r = await call('POST', '/api/editor/versions/1/errata', {
    body: erratumBody('relation', rel, { content: '先后方向存疑' }),
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.erratum.targetType, 'relation');
  const list = await call('GET', '/api/editor/versions/1/errata');
  const e = list.json.errata[0];
  assert.strictEqual(e.earlierTitle, '动员会');
  assert.strictEqual(e.laterTitle, '通水会');
  assert.strictEqual(e.active, true);
});

test('首尾空白被去除；空说明/空出处/非字符串 → 400', async () => {
  const { e1 } = await scenarioV1();
  for (const bad of [
    { content: '   ', source: 's' },
    { content: 'x', source: '   ' },
    { content: 42, source: 's' },
    { content: 'x', source: null },
  ]) {
    const r = await call('POST', '/api/editor/versions/1/errata', {
      body: erratumBody('event', e1, bad),
    });
    assert.strictEqual(r.status, 400, JSON.stringify(bad));
  }
  const r = await call('POST', '/api/editor/versions/1/errata', {
    body: erratumBody('event', e1, { content: '  有效说明  ', source: '  档案 03  ' }),
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.erratum.content, '有效说明');
  assert.strictEqual(r.json.erratum.source, '档案 03');
});

test('targetType 非法、targetId 非正整数、版本号非法 → 400', async () => {
  const { e1, c1 } = await scenarioV1();
  const bads = [
    ['/api/editor/versions/1/errata', erratumBody('claim', c1)],
    ['/api/editor/versions/1/errata', erratumBody('event', -1)],
    ['/api/editor/versions/1/errata', erratumBody('event', 1.5)],
    ['/api/editor/versions/1/errata', erratumBody('event', 'x')],
  ];
  for (const [url, body] of bads) {
    const r = await call('POST', url, { body });
    assert.strictEqual(r.status, 400, JSON.stringify(body));
  }
  const r = await call('POST', '/api/editor/versions/x/errata', { body: erratumBody('event', e1) });
  assert.strictEqual(r.status, 400);
});

test('版本不存在 → 404，不落库', async () => {
  const r = await call('POST', '/api/editor/versions/9/errata', {
    body: erratumBody('event', 1),
  });
  assert.strictEqual(r.status, 404);
  const all = await call('GET', '/api/editor/errata');
  assert.strictEqual(all.json.errata.length, 0);
});

test('对象不存在 / 不属该版 → 422 ERRATA_TARGET_NOT_IN_VERSION', async () => {
  await scenarioV1();
  const r = await call('POST', '/api/editor/versions/1/errata', {
    body: erratumBody('event', 999),
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.code, 'ERRATA_TARGET_NOT_IN_VERSION');
  assert.strictEqual(r.json.targetId, 999);

  const r2 = await call('POST', '/api/editor/versions/1/errata', {
    body: erratumBody('relation', 999),
  });
  assert.strictEqual(r2.status, 422);
});

// ---------- 替代链与乐观并发 ----------

test('替代须提交所见附记号；同目标只展示最新生效，旧附记保留可追溯', async () => {
  const { e1 } = await scenarioV1();
  const a = await call('POST', '/api/editor/versions/1/errata', { body: erratumBody('event', e1) });
  const firstId = a.json.erratum.erratumId;

  // 不带所见号（认为是首条）替代已存在附记 → 409，且响应带当前附记
  const conflict = await call('POST', '/api/editor/versions/1/errata', {
    body: erratumBody('event', e1, { content: '第二次', source: '新出处' }),
  });
  assert.strictEqual(conflict.status, 409);
  assert.strictEqual(conflict.json.code, 'ERRATA_CONFLICT');
  assert.strictEqual(conflict.json.currentErratum.erratumId, firstId);
  assert.strictEqual(conflict.json.currentErratum.content, '日期应为 1959 年春');
  assert.strictEqual(conflict.json.target.title, '动员会');

  // 带正确所见号替代 → 201，supersedes 指向旧附记
  const b = await call('POST', '/api/editor/versions/1/errata', {
    body: erratumBody('event', e1, {
      content: '修正为 1959 年 3 月',
      source: '档案 04',
      expectedErratumId: firstId,
    }),
  });
  assert.strictEqual(b.status, 201, JSON.stringify(b.json));
  assert.strictEqual(b.json.erratum.supersedesErratumId, firstId);
  assert.strictEqual(b.json.previousErratum.erratumId, firstId);
  assert.strictEqual(b.json.erratum.content, '修正为 1959 年 3 月');

  // 访客只见最新一条
  const pub = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pub.json.version.errata.length, 1);
  assert.strictEqual(pub.json.version.errata[0].content, '修正为 1959 年 3 月');
  assert.strictEqual(pub.json.version.errata[0].erratumId, b.json.erratum.erratumId);

  // 旧附记仍在库中、可经替代链追溯
  const list = await call('GET', '/api/editor/versions/1/errata');
  assert.strictEqual(list.json.errata.length, 2);
  assert.deepStrictEqual(list.json.errata.map((x) => x.active), [false, true]);
  const chain = await call('GET', `/api/editor/errata/${firstId}/chain`);
  assert.deepStrictEqual(chain.json.chain.map((x) => x.erratumId), [firstId, b.json.erratum.erratumId]);
  assert.strictEqual(chain.json.activeErratumId, b.json.erratum.erratumId);

  // 单条原文
  const one = await call('GET', `/api/editor/errata/${firstId}`);
  assert.strictEqual(one.json.erratum.content, '日期应为 1959 年春');
});

test('所见附记号过期 → 409，冲突方不落库', async () => {
  const { e1 } = await scenarioV1();
  const a = await call('POST', '/api/editor/versions/1/errata', { body: erratumBody('event', e1) });
  const b = await call('POST', '/api/editor/versions/1/errata', {
    body: erratumBody('event', e1, { content: '第二版', expectedErratumId: a.json.erratum.erratumId }),
  });
  assert.strictEqual(b.status, 201);
  // 仍以旧所见号替代
  const c = await call('POST', '/api/editor/versions/1/errata', {
    body: erratumBody('event', e1, { content: '第三版', expectedErratumId: a.json.erratum.erratumId }),
  });
  assert.strictEqual(c.status, 409);
  assert.strictEqual(c.json.code, 'ERRATA_CONFLICT');
  assert.strictEqual(c.json.currentErratum.erratumId, b.json.erratum.erratumId);
  const list = await call('GET', '/api/editor/versions/1/errata');
  assert.strictEqual(list.json.errata.length, 2); // 没有第 3 行
});

test('两个编辑者同时替代：仅一个成功，另一方 409 且取得当前附记', async () => {
  const { e1 } = await scenarioV1();
  const a = await call('POST', '/api/editor/versions/1/errata', { body: erratumBody('event', e1) });
  const firstId = a.json.erratum.erratumId;

  const results = await Promise.all(
    [1, 2].map((i) =>
      call('POST', '/api/editor/versions/1/errata', {
        body: erratumBody('event', e1, {
          content: `并发替代 ${i}`,
          source: `s${i}`,
          expectedErratumId: firstId,
        }),
      })
    )
  );
  const statuses = results.map((r) => r.status).sort((x, y) => x - y);
  assert.deepStrictEqual(statuses, [201, 409]);
  const ok = results.find((r) => r.status === 201);
  const fail = results.find((r) => r.status === 409);
  assert.strictEqual(fail.json.currentErratum.erratumId, ok.json.erratum.erratumId);
  assert.strictEqual(fail.json.currentErratum.content, ok.json.erratum.content);

  const list = await call('GET', '/api/editor/versions/1/errata');
  assert.strictEqual(list.json.errata.length, 2); // 首条 + 一个成功替代
});

test('两个编辑者同时首登（都提交空所见号）：仅一个成功', async () => {
  const { e1 } = await scenarioV1();
  const results = await Promise.all(
    [1, 2].map((i) =>
      call('POST', '/api/editor/versions/1/errata', {
        body: erratumBody('event', e1, { content: `首登 ${i}`, source: 's', expectedErratumId: 0 }),
      })
    )
  );
  assert.deepStrictEqual(results.map((r) => r.status).sort((x, y) => x - y), [201, 409]);
  const list = await call('GET', '/api/editor/versions/1/errata');
  assert.strictEqual(list.json.errata.length, 1);
});

test('expectedErratumId 非法 → 400', async () => {
  const { e1 } = await scenarioV1();
  const r = await call('POST', '/api/editor/versions/1/errata', {
    body: erratumBody('event', e1, { expectedErratumId: -3 }),
  });
  assert.strictEqual(r.status, 400);
});

test('不同目标的附记互不影响（事件与关系各自一条生效）', async () => {
  const { e1, rel } = await scenarioV1();
  await call('POST', '/api/editor/versions/1/errata', { body: erratumBody('event', e1) });
  await call('POST', '/api/editor/versions/1/errata', { body: erratumBody('relation', rel) });
  const pub = await call('GET', '/api/public/versions/1', { token: null });
  const types = pub.json.version.errata.map((e) => e.targetType).sort();
  assert.deepStrictEqual(types, ['event', 'relation']);
});

// ---------- 读出：访客 / 编辑者 / 遮盖 ----------

test('访客最新年表与指定版本可见生效附记（含目标标题与时间）', async () => {
  const { e1 } = await scenarioV1();
  await call('POST', '/api/editor/versions/1/errata', { body: erratumBody('event', e1) });
  for (const url of ['/api/public/chronicle', '/api/public/versions/1']) {
    const pub = await call('GET', url, { token: null });
    assert.strictEqual(pub.status, 200);
    const e = pub.json.version.errata[0];
    assert.strictEqual(e.targetType, 'event');
    assert.strictEqual(e.targetId, e1);
    assert.strictEqual(e.title, '动员会');
    assert.strictEqual(e.content, '日期应为 1959 年春');
    assert.ok(e.createdAt);
    assert.strictEqual(e.supersedesErratumId, null);
  }
});

test('附记出处沿用精确遮盖规则：访客见「出处已遮盖」，编辑者可见原文', async () => {
  const { e1 } = await scenarioV1();
  const secret = '秘藏档案全宗 99';
  await call('POST', '/api/editor/versions/1/errata', {
    body: erratumBody('event', e1, { source: secret }),
  });
  await call('POST', '/api/editor/redaction', { body: { source: secret, currentVersionNo: 1 } });

  const pub = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pub.json.version.errata[0].source, REDACTED_SOURCE);
  // 快照事件出处不受影响（只遮盖附记出处比对；快照无此文本）
  const raw = await call('GET', '/api/editor/versions/1/raw');
  assert.strictEqual(raw.json.activeErrata[0].source, secret);
  const one = await call('GET', '/api/editor/errata/1');
  assert.strictEqual(one.json.erratum.source, secret);
});

test('无口令访问编辑者接口 → 401', async () => {
  const { e1 } = await scenarioV1();
  const r = await call('POST', '/api/editor/versions/1/errata', {
    token: null,
    body: erratumBody('event', e1),
  });
  assert.strictEqual(r.status, 401);
  const g = await call('GET', '/api/editor/errata', { token: null });
  assert.strictEqual(g.status, 401);
});

test('单条附记 / 替代链不存在 → 404', async () => {
  assert.strictEqual((await call('GET', '/api/editor/errata/123')).status, 404);
  assert.strictEqual((await call('GET', '/api/editor/errata/123/chain')).status, 404);
});

// ---------- 只属于目标版：撤回、不继承、草稿不动 ----------

test('目标版已撤回：拒绝登记 409 VERSION_RETRACTED；撤回后访客不可见', async () => {
  const { e1 } = await scenarioV1();
  await call('POST', '/api/editor/versions/1/errata', { body: erratumBody('event', e1) });
  const rt = await call('POST', '/api/editor/versions/1/retract', { body: { reason: '编年依据错误' } });
  assert.strictEqual(rt.status, 200);

  // 新登记被拒绝
  const r = await call('POST', '/api/editor/versions/1/errata', {
    body: erratumBody('event', e1, { content: '撤回后补记', expectedErratumId: 1 }),
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'VERSION_RETRACTED');

  // 撤回后访客不再看到该版及其附记
  const pub = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(pub.status, 404);
  const chron = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(chron.json.published, false);
  assert.strictEqual(chron.json.allRetracted, true);

  // 编辑者仍可查旧附记（原文）
  const list = await call('GET', '/api/editor/versions/1/errata');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.json.retracted, true);
  assert.strictEqual(list.json.errata.length, 1);
  assert.strictEqual(list.json.errata[0].content, '日期应为 1959 年春');
});

test('附记不随草稿恢复或以后发布的版本继承', async () => {
  const s = await scenarioV1();
  await call('POST', '/api/editor/versions/1/errata', { body: erratumBody('event', s.e1) });

  // 从 v1 恢复草稿：附记不进入草稿
  const prev = await call('GET', '/api/editor/restore-preview/1');
  assert.strictEqual(prev.status, 200);
  const restored = await call('POST', '/api/editor/restore', {
    body: {
      versionNo: 1,
      draftRevisionNo: prev.json.draftRevisionNo,
      currentVersionNo: prev.json.currentVersionNo,
    },
  });
  assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));
  const state = await call('GET', '/api/editor/state');
  assert.ok(!('errata' in state.json));

  // 发布第 2 版：不继承第 1 版附记
  const v2 = await call('POST', '/api/editor/publish', {
    body: {
      selection: restored.json.pendingSelection,
      baseVersionNo: 1,
      note: '恢复后重发',
    },
  });
  assert.strictEqual(v2.status, 201, JSON.stringify(v2.json));
  const pub2 = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pub2.json.currentVersionNo, 2);
  assert.deepStrictEqual(pub2.json.version.errata, []);

  // 第 1 版的附记仍在
  const pub1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(pub1.json.version.errata.length, 1);
  assert.strictEqual(pub1.json.version.errata[0].targetId, s.e1);
});

test('登记附记不推进草稿修订号、不改草稿', async () => {
  const { e1 } = await scenarioV1();
  const before = await call('GET', '/api/editor/state');
  await call('POST', '/api/editor/versions/1/errata', { body: erratumBody('event', e1) });
  const after = await call('GET', '/api/editor/state');
  assert.strictEqual(after.json.draftRevisionNo, before.json.draftRevisionNo);
  assert.strictEqual(after.json.events.length, before.json.events.length);
});

test('编辑者全部附记清单与按版本清单', async () => {
  const { e1, e2, rel } = await scenarioV1();
  await call('POST', '/api/editor/versions/1/errata', { body: erratumBody('event', e1) });
  await call('POST', '/api/editor/versions/1/errata', { body: erratumBody('event', e2, { content: '另一条' }) });
  await call('POST', '/api/editor/versions/1/errata', { body: erratumBody('relation', rel, { content: '关系附记' }) });
  const all = await call('GET', '/api/editor/errata');
  assert.strictEqual(all.json.errata.length, 3);
  const v1 = await call('GET', '/api/editor/versions/1/errata');
  assert.strictEqual(v1.json.errata.length, 3);
  assert.strictEqual(v1.json.activeErrata.length, 3);
});

test('查看不存在版本的附记清单 → 404', async () => {
  const r = await call('GET', '/api/editor/versions/77/errata');
  assert.strictEqual(r.status, 404);
});
