'use strict';

// 访客页：只读最新已发布版本（不可变快照）
const $ = (sel) => document.querySelector(sel);

const PREC_LABEL = { year: '年精度', month: '月精度', day: '日精度' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${y} 年 ${m} 月 ${d} 日`;
}

async function main() {
  const msg = $('#message');
  try {
    const res = await fetch('/api/public/chronicle');
    const data = await res.json();
    if (!data.published) {
      // 尚无版本，或全部已发布版本均已撤回（尚无可读版本）
      msg.innerHTML = data.allRetracted
        ? `<div class="alert warn">${esc(data.message || '尚无可读版本：已发布版本均已撤回')}，请等待编辑者发布修正版本。</div>`
        : '<div class="alert warn">年表尚未发布任何版本，敬请期待。<br><span class="muted">（草稿中的未发布内容对外不可见）</span></div>';
      $('#versionTag').textContent = data.allRetracted ? '尚无可读版本' : '未发布';
      return;
    }
    const v = data.version;
    $('#versionTag').textContent = `第 ${v.versionNo} 版 · 发布于 ${v.publishedAt.replace('T', ' ').slice(0, 16)} UTC · 编辑：${esc(v.editor || '匿名')}`;
    $('#chronicle').style.display = 'grid';
    $('#caveat').textContent = `本页为第 ${v.versionNo} 版不可变快照，共 ${v.eventCount} 个事件、${v.relationCount} 条先后关系。`;

    // 本版当前生效的勘误附记（每目标只展示最新一条；附记只属于本版）
    const errata = Array.isArray(v.errata) ? v.errata : [];
    renderErrata(errata);
    const errataByEvent = new Map();
    const errataByRelation = new Map();
    for (const e of errata) {
      if (e.targetType === 'event') errataByEvent.set(e.targetId, e);
      else errataByRelation.set(e.targetId, e);
    }
    const erratumBadge = (e) =>
      e ? '<span class="badge" style="background:#fdf3e0;color:#9a6a00" title="本对象有编辑者勘误附记（见下方勘误区）">勘误</span>' : '';

    const titleById = new Map(v.events.map((e) => [e.eventId, e.title]));

    $('#timeline').innerHTML = v.events.map((e) => `
      <div class="item">
        <div class="date">${esc(fmtDate(e.resolvedDate))}</div>
        <div><strong>${esc(e.title)}</strong>
          <span class="badge prec">${PREC_LABEL[e.precision] || e.precision}</span>
          ${erratumBadge(errataByEvent.get(e.eventId))}
        </div>
        ${e.description ? `<div class="muted">${esc(e.description)}</div>` : ''}
        <div class="source">
          <b>所选出处：</b>${esc(e.source || '（未注明出处）')}
          <br><span class="muted">原始主张：${esc(e.dateLabel)}
          （覆盖区间 ${e.intervalStart} ~ ${e.intervalEnd}）${e.claimNote ? '；' + esc(e.claimNote) : ''}</span>
        </div>
      </div>
    `).join('');

    $('#relations').innerHTML = v.relations.length
      ? v.relations.map((r) => `
          <div class="rel-line">
            <strong>${esc(titleById.get(r.earlierEventId) || '#' + r.earlierEventId)}</strong>
            <span class="badge">先于</span>
            <strong>${esc(titleById.get(r.laterEventId) || '#' + r.laterEventId)}</strong>
            ${erratumBadge(errataByRelation.get(r.relationId))}
            ${r.source ? `<div class="source"><b>出处：</b>${esc(r.source)}</div>` : ''}
          </div>`).join('')
      : '<p class="muted">本版未记录先于关系。</p>';

    loadRoutes();
  } catch (err) {
    msg.innerHTML = `<div class="alert error">加载失败：${esc(err.message)}</div>`;
  }
}

// ---------- 本版勘误附记（访客只读；每目标仅最新生效一条，出处按遮盖规则显示） ----------
function erratumTargetLine(e) {
  if (e.targetType === 'event') {
    return `事件 <strong>${esc(e.title || '#' + e.targetId)}</strong>`;
  }
  return `「先于」关系 <strong>${esc(e.earlierTitle || '#' + e.earlierEventId)}</strong>
          <span class="badge">先于</span>
          <strong>${esc(e.laterTitle || '#' + e.laterEventId)}</strong>`;
}

function renderErrata(errata) {
  const card = $('#errataCard');
  if (!errata.length) {
    card.style.display = 'none';
    $('#errataList').innerHTML = '';
    return;
  }
  card.style.display = '';
  $('#errataList').innerHTML = errata.map((e) => `
    <div class="rel-line">
      <div>${erratumTargetLine(e)}</div>
      <div class="source" style="margin-top:2px">
        <b>勘误：</b>${esc(e.content)}
        <br><b>出处：</b>${esc(e.source || '（未注明）')}
        <span class="muted"> · ${esc((e.createdAt || '').replace('T', ' ').slice(0, 16))} UTC${e.editor ? ' · ' + esc(e.editor) : ''}</span>
      </div>
    </div>`).join('');
}

// ---------- 专题脉络路线（公开只读，出处已按遮盖规则处理） ----------
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const anchorMark = (pos) => CIRCLED[pos] || `(${pos + 1})`;

async function loadRoutes() {
  try {
    const res = await fetch('/api/public/routes');
    const data = await res.json();
    if (!data.routes || !data.routes.length) return;
    $('#routesCard').style.display = '';
    $('#routeList').innerHTML = data.routes.map((r) => `
      <button class="secondary" type="button" data-open-route="${r.routeNo}" style="margin:0 8px 8px 0">
        ⚑ ${esc(r.title)} <span class="muted">（路线 #${r.routeNo} · 据第 ${r.versionNo} 版 · ${r.anchorCount} 个锚点）</span>
      </button>`).join('');
  } catch { /* 路线加载失败不影响年表主体 */ }
}

async function openRoute(routeNo) {
  const box = $('#routeDetail');
  box.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const res = await fetch(`/api/public/routes/${routeNo}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `请求失败（${res.status}）`);
    box.innerHTML = routeHtml(data.route);
  } catch (err) {
    box.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
  }
}

function routeHtml(route) {
  const evById = new Map(route.events.map((e) => [e.eventId, e]));
  const relById = new Map(route.relations.map((r) => [r.relationId, r]));
  const anchorLine = route.anchors
    .map((a) => `<span class="badge prec">${anchorMark(a.position)} ${esc(a.title)}</span>`)
    .join(' <span class="muted">→</span> ');

  const eventNode = (eid) => {
    const ev = evById.get(eid) || { title: `#${eid}`, role: 'intermediate' };
    const roleBadge = ev.role === 'anchor'
      ? `<span class="badge prec">锚点 ${anchorMark(ev.anchorPosition)}</span>`
      : '<span class="badge">中间事件</span>';
    return `
      <div class="rel-line">
        ${roleBadge} <strong>${esc(ev.title)}</strong>
        ${ev.resolvedDate ? `<span class="muted">${esc(fmtDate(ev.resolvedDate))}</span>` : ''}
        ${ev.dateLabel ? `<div class="muted">原始主张：${esc(ev.dateLabel)}（区间 ${esc(ev.intervalStart)} ~ ${esc(ev.intervalEnd)}）</div>` : ''}
        ${ev.source ? `<div class="source"><b>出处：</b>${esc(ev.source)}</div>` : ''}
      </div>`;
  };

  const segments = route.segments.map((s) => {
    const parts = [];
    s.eventIds.forEach((eid, i) => {
      if (i > 0) {
        const rel = relById.get(s.relationIds[i - 1]) || {};
        parts.push(`
          <div class="muted" style="padding-left:18px">
            ↓ 先于（关系 #${s.relationIds[i - 1]}${rel.source ? `，出处：${esc(rel.source)}` : '，未注明出处'}）
          </div>`);
      }
      parts.push(eventNode(eid));
    });
    return `
      <div class="card" style="background:#fff;margin-bottom:8px">
        <h3 style="font-size:13px">第 ${s.position + 1} 段：锚点 ${anchorMark(s.position)} → 锚点 ${anchorMark(s.position + 1)}
          <span class="muted">（见证链含 ${s.relationIds.length} 条关系，为该版中最少）</span></h3>
        ${parts.join('')}
      </div>`;
  }).join('');

  return `
    <h3 style="margin-top:14px">⚑ ${esc(route.title)} <span class="muted">（路线 #${route.routeNo}）</span></h3>
    <p class="muted">据第 ${route.versionNo} 版年表 · 建立于 ${esc(route.createdAt)} UTC · 编辑：${esc(route.editor || '匿名')}${route.note ? ` · 说明：${esc(route.note)}` : ''}</p>
    <p>${anchorLine}</p>
    ${segments}`;
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const open = t.dataset && t.dataset.openRoute;
  if (open !== undefined) openRoute(Number(open));
});

main();
