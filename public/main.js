import {
  $, el, clear, fmtInt, fmtPct, fmtBytes, fmtMs, fmtHours, fmtUtcFromUs,
  debounce, bindTip, initTheme, api, levelBadge,
} from './lib.js';

const state = {
  meta: null,
  zone: 'America/New_York',
  policy: 'earlier',
  mode: 'zoned',
  expression: "local_date(ts) = DATE '2026-03-08'",
  verify: true,
  fullscan: true,
  result: null,
  mapView: 'grid',
  zoneProfile: null,
  runToken: 0,
};

initTheme($('#theme-toggle'));
$('#f-tz').textContent = '—';

const params = new URLSearchParams(location.search);
if (params.get('zone')) state.zone = params.get('zone');
if (params.get('policy')) state.policy = params.get('policy');
if (params.get('mode')) state.mode = params.get('mode');
if (params.get('expr')) state.expression = params.get('expr');
if (params.get('verify')) state.verify = params.get('verify') !== '0';
if (params.get('fullscan')) state.fullscan = params.get('fullscan') !== '0';

boot();

async function boot() {
  try {
    state.meta = await api('/api/meta');
  } catch (err) {
    clear($('#kpis')).append(el('div', { class: 'kpi' },
      el('div', { class: 'label', text: '无法连接后端' }),
      el('div', { class: 'sub', text: err.message }),
    ));
    $('#expr-status').textContent = '离线';
    return;
  }
  renderRuntimeChips();
  populateControls();
  renderPresets();
  $('#verify').checked = state.verify;
  $('#fullscan').checked = state.fullscan;
  $('#expr').value = state.expression;
  bindEvents();
  run();
}

function renderRuntimeChips() {
  const { runtime, dataset } = state.meta;
  $('#runtime-chips').append(
    el('span', { class: 'chip' }, 'rows ', el('b', { text: fmtInt(dataset.totalRows) })),
    el('span', { class: 'chip' }, '分区 ', el('b', { text: fmtInt(dataset.partitionCount) })),
    el('span', { class: 'chip' }, '区间 ', el('b', { text: `${dataset.firstDayKey} → ${dataset.lastDayKey}` })),
    el('span', { class: 'chip' }, 'tzdata ', el('b', { text: runtime.tz })),
  );
  $('#f-tz').textContent = `ICU ${runtime.icu} · tzdata ${runtime.tz} · sqlite ${runtime.sqlite} · host ${runtime.hostZone}`;
}

function populateControls() {
  const zoneSel = $('#zone');
  const featured = new Set(state.meta.zones.featured);
  for (const z of state.meta.zones.featured) {
    const note = state.meta.zones.notes[z];
    zoneSel.append(el('option', { value: z, text: note ? `${z} — ${note}` : z }));
  }
  const allGroup = el('optgroup', { label: '其它时区' });
  for (const z of state.meta.zones.all) {
    if (featured.has(z)) continue;
    allGroup.append(el('option', { value: z, text: z }));
  }
  zoneSel.append(allGroup);
  if (!state.meta.zones.all.includes(state.zone)) {
    zoneSel.append(el('option', { value: state.zone, text: state.zone }));
  }
  zoneSel.value = state.zone;

  const policySel = $('#policy');
  for (const p of state.meta.policies) policySel.append(el('option', { value: p.id, text: p.label }));
  policySel.value = state.policy;
  updateModeButtons();
}

function updateModeButtons() {
  for (const btn of document.querySelectorAll('#mode-seg button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === state.mode));
  }
}

function renderPresets() {
  const host = clear($('#presets'));
  for (const ex of state.meta.examples) {
    host.append(el('button', {
      class: 'preset',
      type: 'button',
      text: ex.title,
      title: ex.note,
      dataset: { preset: ex.id },
      on: {
        click: () => {
          state.expression = ex.expression;
          state.zone = ex.zone;
          $('#expr').value = ex.expression;
          $('#zone').value = ex.zone;
          markActivePreset(ex.id);
          run();
        },
      },
    }));
  }
  markActivePreset(activePresetId());
}

function activePresetId() {
  const hit = state.meta.examples.find(
    (e) => e.expression === state.expression.trim() && e.zone === state.zone,
  );
  return hit?.id ?? null;
}

function markActivePreset(id) {
  for (const b of document.querySelectorAll('.preset')) {
    b.classList.toggle('on', b.dataset.preset === id);
  }
}

function bindEvents() {
  $('#zone').addEventListener('change', (e) => {
    state.zone = e.target.value;
    markActivePreset(activePresetId());
    run();
  });
  $('#policy').addEventListener('change', (e) => { state.policy = e.target.value; run(); });
  $('#mode-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    updateModeButtons();
    run();
  });
  $('#expr').addEventListener('input', debounce(() => {
    const next = $('#expr').value;
    if (next !== state.expression) $('#expr-status').textContent = '已修改，未执行';
    markActivePreset(activePresetId());
  }, 200));
  $('#expr').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });
  $('#run').addEventListener('click', run);
  $('#verify').addEventListener('change', (e) => { state.verify = e.target.checked; run(); });
  $('#fullscan').addEventListener('change', (e) => { state.fullscan = e.target.checked; run(); });
  $('#map-view-toggle').addEventListener('click', (e) => {
    state.mapView = state.mapView === 'grid' ? 'table' : 'grid';
    const btn = e.currentTarget;
    btn.textContent = state.mapView === 'grid' ? '表格视图' : '网格视图';
    btn.setAttribute('aria-pressed', String(state.mapView === 'table'));
    if (state.result) renderPartitionMap(state.result);
  });
  $('#copy-link').addEventListener('click', async (e) => {
    const url = buildShareUrl();
    try {
      await navigator.clipboard.writeText(url);
      e.currentTarget.textContent = '已复制';
    } catch {
      window.prompt('复制此链接', url);
    }
    setTimeout(() => { e.currentTarget.textContent = '复制查询链接'; }, 1600);
  });
}

function buildShareUrl() {
  const p = new URLSearchParams({
    zone: state.zone, policy: state.policy, mode: state.mode, expr: state.expression,
    verify: state.verify ? '1' : '0', fullscan: state.fullscan ? '1' : '0',
  });
  return `${location.origin}${location.pathname}?${p}`;
}

function setError(message, position) {
  const box = $('#expr-error');
  if (!message) { box.classList.remove('on'); box.textContent = ''; return; }
  const caret = position != null ? `${' '.repeat(Math.min(position, 200))}^\n` : '';
  box.textContent = `${message}\n${caret}`;
  box.classList.add('on');
}

async function loadZoneProfile(zone) {
  if (state.zoneProfile?.zone === zone) return state.zoneProfile;
  try {
    state.zoneProfile = await api(`/api/zone?zone=${encodeURIComponent(zone)}`);
  } catch {
    state.zoneProfile = { zone, unusualDays: [], transitions: [] };
  }
  return state.zoneProfile;
}

async function run() {
  state.expression = $('#expr').value;
  const token = ++state.runToken;
  setError(null);
  const btn = $('#run');
  btn.disabled = true;
  btn.textContent = '执行中…';
  $('#expr-status').textContent = '执行中';
  const frame = document.querySelector('.wrap');
  frame.classList.add('loading');

  const profilePromise = state.mode === 'zoned' ? loadZoneProfile(state.zone) : Promise.resolve(null);

  try {
    const body = await api('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expression: state.expression,
        zone: state.zone,
        policy: state.policy,
        mode: state.mode,
        verify: state.verify,
        withFullScan: state.fullscan,
        limit: 100,
      }),
    });
    if (token !== state.runToken) return;
    state.result = body;
    await profilePromise;
    if (token !== state.runToken) return;
    renderAll(body);
    const s = body.stats;
    $('#expr-status').textContent = `完成 · 编译 ${fmtMs(s.compileMs)} · 扫描 ${fmtMs(s.evalMs)}`;
    history.replaceState(null, '', buildShareUrl());
  } catch (err) {
    if (token !== state.runToken) return;
    setError(err.message, err.position);
    $('#expr-status').textContent = '执行失败';
    clear($('#kpis')).append(el('div', { class: 'kpi' },
      el('div', { class: 'label', text: '查询失败' }),
      el('div', { class: 'sub', text: err.message }),
    ));
    for (const sel of ['#map', '#intervals', '#ast', '#verify-body', '#rows-body', '#diagnostics']) clear($(sel));
  } finally {
    if (token === state.runToken) {
      btn.disabled = false;
      btn.textContent = '执行查询';
      frame.classList.remove('loading');
    }
  }
}

function renderAll(r) {
  renderKpis(r);
  renderPartitionMap(r);
  renderIntervals(r);
  renderAst(r);
  renderVerification(r);
  renderRows(r);
  renderDiagnostics(r);
}

// ---------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------

function renderKpis(r) {
  const host = clear($('#kpis'));
  const s = r.stats;
  const ps = r.query.compiled.partitionStats;
  const tiles = [
    {
      label: '命中行',
      value: fmtInt(s.matched),
      sub: `扫描 ${fmtInt(s.scannedRows)} 行 · 过滤率 ${fmtPct(s.scannedRows ? 1 - s.matched / s.scannedRows : 0)}`,
    },
    {
      label: '扫描分区',
      value: fmtInt(s.scannedPartitions),
      suffix: `/ ${fmtInt(s.totalPartitions)}`,
      sub: `剪掉 ${fmtInt(ps.prunedPartitions)} 个 · ${fmtPct(ps.prunedRatio)} 未打开`,
    },
    {
      label: '用时（裁剪路径）',
      value: fmtMs(s.compileMs + s.evalMs),
      sub: s.fullScan ? `全表 ${fmtMs(s.fullScan.ms)} · 快 ${speedupLabel(s.speedup)}×` : '未运行全表基线',
    },
    {
      label: 'UTC 区间',
      value: fmtInt(r.query.compiled.coverage.intervalCount),
      suffix: '段',
      sub: `合计 ${fmtHours(r.query.compiled.coverage.widthHours)} · 本地日 ${r.query.compiled.localDays?.count ?? '—'} 天`,
    },
  ];
  for (const t of tiles) {
    host.append(el('div', { class: 'kpi' },
      el('div', { class: 'label', text: t.label }),
      el('div', { class: 'value' }, t.value, t.suffix ? el('small', { text: t.suffix }) : null),
      el('div', { class: 'sub', text: t.sub }),
    ));
  }
}

function speedupLabel(n) {
  if (n == null) return '—';
  return n >= 10 ? n.toFixed(0) : n.toFixed(1);
}

// ---------------------------------------------------------------------------
// Partition map: Monday-first calendar of the year, one cell per UTC day
// ---------------------------------------------------------------------------

const WEEKDAY_HEADERS = ['一', '二', '三', '四', '五', '六', '日'];
const RAMP = ['--seq-150', '--seq-250', '--seq-350', '--seq-450', '--seq-550', '--seq-650', '--seq-700'];

function rampColor(frac) {
  const idx = Math.min(RAMP.length - 1, Math.max(0, Math.floor(frac * RAMP.length)));
  return `var(${RAMP[idx]})`;
}

function renderPartitionMap(r) {
  const host = $('#map-host');
  const tableHost = $('#map-table-host');
  $('#partition-hint').textContent = `${fmtInt(r.stats.scannedPartitions)} 个分区被打开 · 点击任意日期下钻`;
  if (state.mapView === 'table') {
    host.hidden = true;
    tableHost.hidden = false;
    renderPartitionTable(r, tableHost);
    return;
  }
  host.hidden = false;
  tableHost.hidden = true;

  const selected = new Map(r.query.compiled.partitions.map((p) => [p.dayKey, p]));
  const unusual = new Set((state.zoneProfile?.unusualDays ?? []).map((u) => u.dayKey));
  const manifest = state.meta.dataset;
  const first = new Date(`${manifest.firstDayKey}T00:00:00Z`);
  const dayCount = Math.round((new Date(`${manifest.lastDayKey}T00:00:00Z`) - first) / 86400000) + 1;
  const lead = (first.getUTCDay() + 6) % 7;
  const weekCount = Math.ceil((lead + dayCount) / 7);
  const dayKeyAt = (idx) => new Date(first.getTime() + idx * 86400000).toISOString().slice(0, 10);

  const map = clear($('#map'));
  map.style.gridTemplateColumns = `34px repeat(${weekCount}, minmax(0, 1fr))`;
  map.style.setProperty('--days', String(weekCount));

  map.append(el('div', { class: 'm-head' }));
  const monthMarks = new Map();
  for (let idx = 0; idx < dayCount; idx += 1) {
    const d = new Date(first.getTime() + idx * 86400000);
    if (idx === 0 || d.getUTCDate() === 1) monthMarks.set(Math.floor((lead + idx) / 7), d.getUTCMonth() + 1);
  }
  for (let w = 0; w < weekCount; w += 1) {
    map.append(el('div', { class: 'm-head', text: monthMarks.has(w) ? String(monthMarks.get(w)) : '' }));
  }

  for (let wd = 0; wd < 7; wd += 1) {
    map.append(el('div', { class: 'm-month', text: WEEKDAY_HEADERS[wd] }));
    for (let w = 0; w < weekCount; w += 1) {
      const idx = w * 7 + wd - lead;
      if (idx < 0 || idx >= dayCount) {
        map.append(el('div', { class: 'cell empty' }));
        continue;
      }
      const key = dayKeyAt(idx);
      const sel = selected.get(key);
      const isUnusual = unusual.has(key);
      const cell = el('div', {
        class: `cell ${sel ? 'selected' : 'pruned'}${isUnusual ? ' unusual' : ''}`,
        role: 'button',
        tabindex: '0',
        'aria-label': (sel
          ? `${key} 已选择，覆盖 ${fmtPct(sel.coverageRatio)}`
          : `${key} 已剪枝`) + (isUnusual ? '，本地日非 24 小时' : ''),
        dataset: { day: key },
        style: sel ? { background: rampColor(Math.max(sel.coverageRatio, 0.08)) } : {},
      });
      bindTip(cell, () => key, () => {
        if (!sel) return [['状态', '已剪枝'], ['覆盖', '0'], ['操作', '点击下钻']];
        const rows = [
          ['状态', sel.fullDay ? '整日选中' : '部分选中'],
          ['覆盖', `${fmtPct(sel.coverageRatio)} · ${fmtHours(sel.overlapUs / 3.6e9)}`],
        ];
        if (sel.loLocal) rows.push(['本地', `${sel.loLocal.slice(0, 16)} → ${sel.hiLocal.slice(0, 16)}`]);
        if (isUnusual) rows.push(['注意', '本地日非 24h 或午夜异常']);
        rows.push(['操作', '点击下钻']);
        return rows;
      });
      const go = () => navigateDay(key);
      cell.addEventListener('click', go);
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
      map.append(cell);
    }
  }

  const legend = clear($('#map-legend'));
  legend.append(el('span', { text: '覆盖比例' }));
  const sw = el('span', { class: 'legend-swatches' });
  for (const step of RAMP) sw.append(el('i', { style: { background: `var(${step})` } }));
  legend.append(sw, el('span', { text: '少 → 多' }));
  legend.append(el('span', { style: { marginLeft: '12px' } },
    el('i', { style: { display: 'inline-block', width: '16px', height: '10px', borderRadius: '2px', background: 'var(--surface-2)', border: '1px solid var(--border)', marginRight: '5px' } }),
    '已剪枝'));
  if (unusual.size) {
    legend.append(el('span', { style: { marginLeft: '12px' } },
      el('i', { style: { display: 'inline-block', width: '16px', height: '10px', borderRadius: '2px', boxShadow: 'inset 0 0 0 1.5px var(--series-2)', marginRight: '5px' } }),
      `本地日非 24h（${unusual.size} 天）`));
  }
}

function renderPartitionTable(r, host) {
  clear(host);
  const stats = new Map(r.partitions.map((p) => [p.dayKey, p]));
  const rows = r.query.compiled.partitions
    .slice()
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  const tbl = el('table');
  tbl.append(el('thead', {}, el('tr', {},
    el('th', { text: '分区' }),
    el('th', { class: 'num', text: '覆盖' }),
    el('th', { class: 'num', text: '重叠' }),
    el('th', { class: 'num', text: '扫描行' }),
    el('th', { class: 'num', text: '命中行' }),
    el('th', { text: '类型' }),
    el('th', { text: '本地范围' }),
    el('th', { text: '' }),
  )));
  const body = el('tbody');
  if (rows.length === 0) {
    body.append(el('tr', {}, el('td', { colspan: '8', class: 'empty-state', text: '没有选中任何分区（谓词无解或全部被剪枝）' })));
  }
  for (const p of rows) {
    const ps = stats.get(p.dayKey);
    body.append(el('tr', {},
      el('td', { class: 'mono', text: p.dayKey }),
      el('td', { class: 'num', text: fmtPct(p.coverageRatio) }),
      el('td', { class: 'num', text: fmtHours(p.overlapUs / 3.6e9) }),
      el('td', { class: 'num', text: fmtInt(ps?.rowsScanned ?? 0) }),
      el('td', { class: 'num', text: fmtInt(ps?.rowsMatched ?? 0) }),
      el('td', { text: p.fullDay ? '整日' : '部分' }),
      el('td', { class: 'mono', text: p.loLocal ? `${p.loLocal.slice(0, 16)} → ${p.hiLocal.slice(0, 16)}` : '—' }),
      el('td', {}, el('button', { class: 'ghost', type: 'button', text: '下钻', on: { click: () => navigateDay(p.dayKey) } })),
    ));
  }
  tbl.append(body);
  host.append(el('div', { class: 'table-scroll' }, tbl));
}

// ---------------------------------------------------------------------------
// Interval set
// ---------------------------------------------------------------------------

function renderIntervals(r) {
  const host = clear($('#intervals'));
  const ivs = r.query.compiled.intervals;
  const cov = r.query.compiled.coverage;
  $('#interval-hint').textContent = `${ivs.length} 段 · 合计 ${fmtHours(cov.widthHours)}`;
  clear($('#interval-notes'));

  if (ivs.length === 0) {
    host.append(el('div', { class: 'empty-state', text: '谓词不匹配任何时刻（UTC 区间集为空）' }));
    return;
  }
  const maxWidth = Math.max(...ivs.map((iv) => iv.hiUs - iv.loUs));
  const show = ivs.slice(0, 20);
  for (const [idx, iv] of show.entries()) {
    const width = iv.hiUs - iv.loUs;
    host.append(el('div', { class: 'iv-row' },
      el('div', { class: 'idx', text: String(idx + 1) }),
      el('div', {},
        el('div', { class: 'iv-bar', style: { width: `${Math.max(3, (width / maxWidth) * 100)}%` } }),
        el('div', { class: 'iv-meta', style: { marginTop: '4px' }, text: `${fmtUtcFromUs(iv.loUs)} → ${fmtUtcFromUs(iv.hiUs)}` }),
        iv.loLocal
          ? el('div', { class: 'iv-meta', text: `本地 ${iv.loLocal.slice(0, 16)} → ${iv.hiLocal.slice(0, 16)}` })
          : null,
      ),
      el('div', { class: 'iv-meta', text: fmtHours(width / 3.6e9) }),
    ));
  }
  if (ivs.length > show.length) {
    host.append(el('div', { class: 'hint', text: `另有 ${ivs.length - show.length} 段未展示（互不相邻）` }));
  }

  const notes = [...new Set(r.query.compiled.nodes.flatMap((n) => n.notes ?? []))];
  if (notes.length) {
    const wrap = $('#interval-notes');
    wrap.append(el('div', { class: 'hint', text: '区间说明', style: { marginBottom: '8px' } }));
    const list = el('div', { class: 'note-list' });
    for (const n of notes.slice(0, 6)) {
      list.append(el('div', { class: 'note' }, el('span', { class: 'dot' }), el('span', { text: n })));
    }
    wrap.append(list);
  }
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

function renderAst(r) {
  const host = clear($('#ast'));
  const nodes = r.query.compiled.nodes;
  if (!nodes.length) {
    host.append(el('div', { class: 'empty-state', text: '无节点' }));
    return;
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const walk = (id) => {
    const node = byId.get(id);
    if (!node) return;
    const row = el('div', { class: 'ast-node', style: { marginLeft: `${node.depth * 14}px` } },
      el('div', { class: 'lbl', text: node.label ?? node.type.toUpperCase() }),
      el('div', { class: 'ops' }, el('b', { text: fmtInt(node.intervalCount) }), ` 段 · ${fmtHours(node.widthHours)}`),
    );
    bindTip(row, () => node.label ?? node.type.toUpperCase(), () => [
      ['区间', fmtInt(node.intervalCount)],
      ['宽度', fmtHours(node.widthHours)],
      ...(node.details?.dayKey ? [['日期', node.details.dayKey]] : []),
      ...(node.details?.dayLengthSec ? [['本地日长', fmtHours(node.details.dayLengthSec / 3600)]] : []),
      ['子节点', String(node.childIds.length)],
    ]);
    host.append(row);
    for (const child of node.childIds) walk(child);
  };
  for (const node of nodes) if (node.depth === 0) walk(node.id);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function renderVerification(r) {
  const host = clear($('#verify-body'));
  const v = r.verification;
  $('#verify-hint').textContent = v
    ? `探针 ${fmtInt(v.intervalSemantics.probes)} · 逐行 ${fmtInt(v.rowScan.rowsChecked)}`
    : '未运行';
  if (!v) {
    host.append(el('div', { class: 'empty-state', text: '勾选“运行一致性核对”以复核' }));
    return;
  }
  host.append(el('div', { class: `verdict ${v.ok ? 'ok' : 'bad'}` },
    el('span', { class: 'badge', text: v.ok ? '✓' : '✕' }),
    el('span', { text: v.ok ? '所有核对通过' : '发现不一致，见下方明细' }),
  ));

  const aggOk = v.aggregates.bucketAgrees === true || v.aggregates.partitionAgrees === true;
  const checks = [
    {
      ok: v.intervalSemantics.ok,
      title: '区间语义',
      detail: `${fmtInt(v.intervalSemantics.probes)} 探针 · 不符 ${v.intervalSemantics.mismatches.length}`,
      desc: '在分区边界、偏移跳变点与每个区间端点抽样，逐点比较逐行谓词真值与区间集成员关系',
    },
    {
      ok: v.partitionSelection.ok,
      title: '分区选择',
      detail: `${fmtInt(v.partitionSelection.selectedCount)}/${fmtInt(v.partitionSelection.totalCount)} · 遗漏 ${v.partitionSelection.rowsOutsideSelection.length}`,
      desc: '逐行暴力扫描：任何命中行都必须落在已选分区内；每个被选分区必须真的包含满足谓词的时刻',
    },
    {
      ok: aggOk,
      title: '聚合一致',
      detail: v.aggregates.bucketRollup.exact
        ? `分钟桶 ${fmtInt(v.aggregates.bucketRollup.buckets)} 个`
        : (v.aggregates.partitionRollup.exact ? `分区清单 ${fmtInt(v.aggregates.partitionRollup.partitions)} 个` : '无精确聚合'),
      desc: '分钟桶聚合或分区清单聚合与逐行累加逐项核对（count、字节、延迟、错误数）',
    },
    {
      ok: v.rowScan.matched === r.stats.matched,
      title: '裁剪 = 全表',
      detail: `${fmtInt(v.rowScan.matched)} vs ${fmtInt(r.stats.matched)}`,
      desc: '同一逐行谓词下，只打开选中分区与打开全部分区必须得到相同命中数',
    },
  ];
  const list = el('div', { class: 'checks' });
  for (const c of checks) {
    const cls = c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'skip';
    list.append(el('div', { class: 'check-row' },
      el('span', { class: `ico ${cls}`, text: cls === 'ok' ? '✓' : cls === 'bad' ? '✕' : '–', 'aria-hidden': 'true' }),
      el('div', {},
        el('div', { text: c.title }),
        el('div', { class: 'hint', style: { fontSize: '11px', marginTop: '2px' }, text: c.desc }),
      ),
      el('div', { class: 'detail', text: c.detail }),
    ));
  }
  host.append(list);

  const truth = v.aggregates.rowScan;
  const aggRows = [el('div', { class: 'mini-row' },
    el('span', { class: 'k', text: '逐行真值' }),
    el('span', { class: 'mono', text: `${fmtInt(truth.count)} 行 · ${fmtBytes(truth.sumBytes)} · ${fmtInt(truth.sumLatencyMs)} ms · ${fmtInt(truth.errorCount)} 错误` }),
  )];
  if (v.aggregates.bucketRollup.exact) {
    const b = v.aggregates.bucketRollup;
    aggRows.push(el('div', { class: 'mini-row' },
      el('span', { class: 'k', text: '分钟桶聚合' }),
      el('span', { class: 'mono', text: `${fmtInt(b.count)} 行 · ${fmtBytes(b.sumBytes)} · ${fmtInt(b.sumLatencyMs)} ms · ${fmtInt(b.errorCount)} 错误` }),
    ));
  }
  host.append(el('div', { class: 'mini-list', style: { marginTop: '10px' } }, ...aggRows));

  if (v.intervalSemantics.mismatches.length) {
    const tbl = el('table', { style: { marginTop: '10px' } });
    tbl.append(el('thead', {}, el('tr', {},
      el('th', { text: '即时' }), el('th', { text: '本地' }), el('th', { text: '逐行谓词' }), el('th', { text: '区间集' }),
    )));
    const body = el('tbody');
    for (const m of v.intervalSemantics.mismatches.slice(0, 6)) {
      body.append(el('tr', {},
        el('td', { class: 'mono', text: fmtUtcFromUs(m.tsUs) }),
        el('td', { class: 'mono', text: m.local ?? '—' }),
        el('td', { text: String(m.predicate) }),
        el('td', { text: String(m.intervalSet) }),
      ));
    }
    tbl.append(body);
    host.append(tbl);
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function renderRows(r) {
  const body = clear($('#rows-body'));
  const rows = r.rows;
  $('#rows-hint').textContent = rows.length
    ? `显示 ${fmtInt(rows.length)} / ${fmtInt(r.stats.matched)} 行${r.hiddenRows ? ` · 另 ${fmtInt(r.hiddenRows)} 行未展示` : ''}`
    : '';
  $('#rows-empty').hidden = rows.length > 0;
  for (const row of rows) {
    body.append(el('tr', {},
      el('td', { class: 'num mono', text: row.id }),
      el('td', { class: 'mono', text: row.utc }),
      el('td', { class: 'mono', text: row.local ?? '—' }),
      el('td', { class: 'mono' }, el('a', {
        href: dayHref(row.partition),
        text: row.partition,
        on: { click: (e) => { e.preventDefault(); navigateDay(row.partition); } },
      })),
      el('td', { text: row.service }),
      el('td', {}, levelBadge(row.level)),
      el('td', { class: 'num mono', text: String(row.latencyMs) }),
      el('td', { class: 'num mono', text: fmtInt(row.bytes) }),
      el('td', { text: row.msg }),
      el('td', {}, el('button', { class: 'ghost', type: 'button', text: '下钻', on: { click: () => navigateDay(row.partition) } })),
    ));
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function renderDiagnostics(r) {
  const host = clear($('#diagnostics'));
  const d = r.query.compiled.diagnostics;
  const notes = [];

  for (const t of (d.transitions ?? []).slice(0, 4)) {
    notes.push({
      kind: 'warn',
      text: `${t.kind === 'gap' ? '跳过' : '回拨'} ${t.deltaSec > 0 ? '+' : ''}${t.deltaSec / 60} 分钟于 ${t.atUtc}：本地 ${t.localBefore} → ${t.localAfter}。`,
    });
  }
  for (const note of [...new Set(r.query.compiled.nodes.flatMap((n) => n.notes ?? []))].slice(0, 4)) {
    notes.push({ kind: 'warn', text: note });
  }
  for (const u of (d.unusualDays ?? []).slice(0, 4)) {
    if (u.lengthHours === 24 && u.midnightStatus === 'normal') continue;
    notes.push({
      kind: 'warn',
      text: `${u.dayKey} 本地日长 ${fmtHours(u.lengthHours)}${u.midnightStatus === 'skipped' ? ' · 午夜不存在' : u.midnightStatus === 'repeated' ? ' · 午夜出现两次' : ''} · ${u.startLocal.slice(0, 16)} → ${u.endLocal.slice(0, 16)}`,
    });
  }
  if (r.naive) {
    if (r.naive.onlyZoned.length) {
      notes.push({
        kind: 'warn',
        text: `朴素实现（按 UTC 日期裁剪）会漏开 ${r.naive.onlyZoned.length} 个分区、约 ${fmtInt(r.naive.missedRows)} 行命中：${r.naive.onlyZoned.slice(0, 5).join(', ')}${r.naive.onlyZoned.length > 5 ? ' …' : ''}`,
      });
    } else {
      notes.push({ kind: 'ok', text: '本查询在时区感知与朴素实现下选中相同分区（该日期没有跨午夜的偏移变化）。' });
    }
    if (r.naive.onlyNaive.length) {
      notes.push({ kind: 'warn', text: `朴素实现还会多开 ${r.naive.onlyNaive.length} 个不必要分区：${r.naive.onlyNaive.slice(0, 5).join(', ')}` });
    }
  }

  const rollup = r.aggregates.rollup;
  notes.push({
    kind: 'ok',
    text: rollup.exact
      ? (rollup.method === 'buckets'
        ? `聚合走分钟桶（${fmtInt(rollup.buckets)} 个桶，读 0 行）：${fmtInt(rollup.count)} 行 / ${fmtBytes(rollup.sumBytes)}。`
        : `聚合走分区清单（${fmtInt(rollup.partitions)} 个分区，读 0 行）：${fmtInt(rollup.count)} 行 / ${fmtBytes(rollup.sumBytes)}。`)
      : `聚合无法走预聚合：${rollup.reason}；已改用逐行累加结果。`,
  });

  const list = el('div', { class: 'note-list' });
  for (const n of notes) {
    list.append(el('div', { class: `note ${n.kind === 'warn' ? 'warn' : ''}` }, el('span', { class: 'dot' }), el('span', { text: n.text })));
  }
  host.append(list);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function dayHref(dayKey) {
  const p = new URLSearchParams({
    day: dayKey, zone: state.zone, policy: state.policy, mode: state.mode, expr: state.expression,
  });
  return `/drill.html?${p}`;
}

function navigateDay(dayKey) {
  location.href = dayHref(dayKey);
}
