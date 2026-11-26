import {
  $, el, clear, fmtInt, fmtPct, fmtBytes, fmtHours, fmtUtcFromUs, bindTip,
  initTheme, api, levelBadge,
} from './lib.js';

initTheme($('#theme-toggle'));

const params = new URLSearchParams(location.search);
const state = {
  meta: null,
  day: params.get('day') || '',
  zone: params.get('zone') || 'America/New_York',
  policy: params.get('policy') || 'earlier',
  mode: params.get('mode') || 'zoned',
  expression: params.get('expr') || '',
  data: null,
  hoursView: 'chart',
};

localStorage.setItem('zsl-last-drill', location.search);

boot();

async function boot() {
  try {
    state.meta = await api('/api/meta');
  } catch (err) {
    $('#day-title').textContent = '无法连接后端';
    return;
  }
  $('#f-tz').textContent = `ICU ${state.meta.runtime.icu} · tzdata ${state.meta.runtime.tz} · host ${state.meta.runtime.hostZone}`;
  $('#runtime-chips').append(
    el('span', { class: 'chip' }, 'rows ', el('b', { text: fmtInt(state.meta.dataset.totalRows) })),
    el('span', { class: 'chip' }, '分区 ', el('b', { text: fmtInt(state.meta.dataset.partitionCount) })),
  );
  populateControls();
  bindEvents();
  if (!state.day) state.day = state.meta.dataset.firstDayKey;
  await load();
}

function populateControls() {
  const zoneSel = $('#zone');
  const featured = new Set(state.meta.zones.featured);
  for (const z of state.meta.zones.featured) zoneSel.append(el('option', { value: z, text: z }));
  const others = el('optgroup', { label: '其它时区' });
  for (const z of state.meta.zones.all) if (!featured.has(z)) others.append(el('option', { value: z }));
  zoneSel.append(others);
  if (![...zoneSel.options].some((o) => o.value === state.zone)) {
    zoneSel.append(el('option', { value: state.zone, text: state.zone }));
  }
  zoneSel.value = state.zone;
  const policySel = $('#policy');
  for (const p of state.meta.policies) policySel.append(el('option', { value: p.id, text: p.label }));
  policySel.value = state.policy;
}

function bindEvents() {
  $('#zone').addEventListener('change', (e) => { state.zone = e.target.value; load(); });
  $('#policy').addEventListener('change', (e) => { state.policy = e.target.value; load(); });
  $('#prev-day').addEventListener('click', () => shiftDay(-1));
  $('#next-day').addEventListener('click', () => shiftDay(1));
  $('#hours-view-toggle').addEventListener('click', (e) => {
    state.hoursView = state.hoursView === 'chart' ? 'table' : 'chart';
    e.currentTarget.textContent = state.hoursView === 'chart' ? '表格视图' : '图表视图';
    e.currentTarget.setAttribute('aria-pressed', String(state.hoursView === 'table'));
    if (state.data) renderHours(state.data);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'ArrowLeft') shiftDay(-1);
    if (e.key === 'ArrowRight') shiftDay(1);
  });
}

function shiftDay(delta) {
  const d = new Date(`${state.day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  state.day = d.toISOString().slice(0, 10);
  load();
}

function dayUrl(dayKey) {
  const p = new URLSearchParams({ day: dayKey, zone: state.zone, policy: state.policy, mode: state.mode });
  if (state.expression) p.set('expr', state.expression);
  return `/drill.html?${p}`;
}

function workbenchUrl() {
  const p = new URLSearchParams({ zone: state.zone, policy: state.policy, mode: state.mode });
  if (state.expression) p.set('expr', state.expression);
  return `/?${p}`;
}

async function load() {
  const frame = document.querySelector('.wrap');
  frame.classList.add('fade-refetch', 'loading');
  try {
    const q = new URLSearchParams({ day: state.day, zone: state.zone, policy: state.policy, mode: state.mode });
    if (state.expression) q.set('expression', state.expression);
    state.data = await api(`/api/day?${q}`);
    history.replaceState(null, '', dayUrl(state.day));
    renderAll(state.data);
  } catch (err) {
    clear($('#kpis'));
    $('#day-title').textContent = state.day;
    clear($('#partition-facts')).append(el('div', { class: 'empty-state', text: err.message }));
  } finally {
    frame.classList.remove('loading');
  }
}

function renderAll(d) {
  renderHeader(d);
  renderKpis(d);
  renderPartitionFacts(d);
  renderSelection(d);
  renderAnatomy(d);
  renderTransitions(d);
  renderHours(d);
  renderReconciliation(d);
  renderBoundary(d);
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader(d) {
  $('#day-title').textContent = `${d.dayKey} 周${d.weekday}`;
  const prev = d.coverage.firstDayKey < d.dayKey;
  const next = d.coverage.lastDayKey > d.dayKey;
  $('#prev-day').disabled = !prev;
  $('#next-day').disabled = !next;
  $('#prev-day').setAttribute('aria-disabled', String(!prev));
  $('#next-day').setAttribute('aria-disabled', String(!next));

  const crumbs = clear($('#crumbs'));
  crumbs.append(
    el('a', { href: workbenchUrl(), text: '← 返回实验台' }),
    el('span', { text: '/' }),
    el('span', { class: 'mono', text: d.partition.table }),
    el('span', { text: '/' }),
    el('span', { text: `${d.zone} · ${d.mode === 'naive' ? '按 UTC 直读' : '时区感知'} · ${d.policy}` }),
  );

  const badges = clear($('#day-badges'));
  const current = d.anatomy.find((a) => a.dayKey === d.dayKey);
  if (current) {
    const unusual = current.lengthHours !== 24;
    if (unusual) {
      badges.append(el('span', { class: 'badge-pill dst', text: `本地日 ${fmtHours(current.lengthHours)}` }));
    }
    if (current.midnightStatus === 'skipped') {
      badges.append(el('span', { class: 'badge-pill gap', text: '本地午夜不存在' }));
    } else if (current.midnightStatus === 'repeated') {
      badges.append(el('span', { class: 'badge-pill fold', text: '本地午夜出现两次' }));
    }
    if (d.transitions.length) {
      const tr = d.transitions[0];
      badges.append(el('span', {
        class: `badge-pill ${tr.kind === 'gap' ? 'gap' : 'fold'}`,
        text: `${tr.kind === 'gap' ? '跳变 +' : '回拨 '}${tr.deltaSec / 60} 分 @ ${tr.atUtc.slice(11, 16)}Z`,
      }));
    }
    if (!unusual && current.midnightStatus === 'normal' && !d.transitions.length) {
      badges.append(el('span', { class: 'badge-pill', text: '常规 24h 本地日' }));
    }
  }
  if (d.selection?.selected) {
    badges.append(el('span', {
      class: 'badge-pill fold',
      text: `查询命中本分区 ${fmtPct(d.selection.coverageRatio)}`,
    }));
  } else if (d.selection && d.selection.selected === false) {
    badges.append(el('span', { class: 'badge-pill', text: '查询已剪掉本分区' }));
  }
}

// ---------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------

function renderKpis(d) {
  const host = clear($('#kpis'));
  const p = d.partition;
  const current = d.anatomy.find((a) => a.dayKey === d.dayKey);
  const rowsInLocalDay = d.localDays.find((x) => x.dayKey === d.dayKey);
  const tiles = [
    { label: '分区行数', value: fmtInt(p.rowCount), sub: `${p.serviceCount} 个服务 · ${fmtInt(p.errorCount)} 条错误` },
    { label: '分区合计字节', value: fmtBytes(p.sumBytes), sub: `平均延迟 ${(p.sumLatencyMs / Math.max(1, p.rowCount)).toFixed(1)} ms` },
    {
      label: '本地日长',
      value: current ? fmtHours(current.lengthHours) : '—',
      sub: current ? `${current.startLocal.slice(0, 16)} → ${current.endLocal.slice(0, 16)}` : '未启用时间线',
    },
    {
      label: '落在本地当日',
      value: d.mode === 'zoned' ? fmtInt(rowsInLocalDay?.rows ?? 0) : '—',
      sub: d.mode === 'zoned'
        ? `占分区 ${fmtPct((rowsInLocalDay?.rows ?? 0) / Math.max(1, p.rowCount))} · 其余属于相邻本地日`
        : '按 UTC 直读模式无本地日概念',
    },
  ];
  for (const t of tiles) {
    host.append(el('div', { class: 'kpi' },
      el('div', { class: 'label', text: t.label }),
      el('div', { class: 'value', text: t.value }),
      el('div', { class: 'sub', text: t.sub }),
    ));
  }
}

// ---------------------------------------------------------------------------
// Physical partition facts
// ---------------------------------------------------------------------------

function renderPartitionFacts(d) {
  const host = clear($('#partition-facts'));
  const p = d.partition;
  $('#partition-hint').textContent = p.table;
  const facts = [
    ['表名', p.table],
    ['UTC 起点', p.loUtc],
    ['UTC 终点（含）', p.hiUtc],
    ['行数', fmtInt(p.rowCount)],
    ['min(ts_us)', fmtUtcFromUs(p.minTsUs)],
    ['max(ts_us)', fmtUtcFromUs(p.maxTsUs)],
    ['合计字节', fmtInt(p.sumBytes)],
    ['合计延迟', `${fmtInt(p.sumLatencyMs)} ms`],
    ['错误行', fmtInt(p.errorCount)],
    ['服务数', fmtInt(p.serviceCount)],
  ];
  const list = el('div', { class: 'mini-list' });
  for (const [k, v] of facts) {
    list.append(el('div', { class: 'mini-row' }, el('span', { class: 'k', text: k }), el('span', { class: 'mono', text: String(v) })));
  }
  host.append(list);
  host.append(el('div', { class: 'hint', style: { marginTop: '10px' }, text: '分区按 UTC 日切分；本地日是另一层语义，二者边界不必对齐。' }));
}

// ---------------------------------------------------------------------------
// Query selection within this partition
// ---------------------------------------------------------------------------

function renderSelection(d) {
  const host = clear($('#selection'));
  const hint = $('#selection-hint');
  const s = d.selection;
  if (!s) {
    hint.textContent = '未附带表达式';
    host.append(el('div', { class: 'empty-state', text: '从实验台点击“下钻”时会带上查询表达式' }));
    return;
  }
  if (s.error) {
    hint.textContent = '表达式无法编译';
    host.append(el('div', { class: 'empty-state', text: s.error }));
    return;
  }
  if (!s.selected) {
    hint.textContent = '已剪枝';
    host.append(el('div', { class: 'verdict ok' },
      el('span', { class: 'badge', text: '✓' }),
      el('span', { text: '该查询不会打开此分区：UTC 区间集与这个 UTC 日不重叠' }),
    ));
    host.append(el('div', { class: 'hint', style: { marginTop: '10px' }, text: `查询共 ${fmtInt(s.totalIntervals)} 段 UTC 区间，均不落在本日。` }));
    return;
  }
  hint.textContent = `${fmtPct(s.coverageRatio)} 覆盖`;
  host.append(el('div', { class: 'mini-list', style: { marginBottom: '10px' } },
    el('div', { class: 'mini-row' }, el('span', { class: 'k', text: '选中方式' }), el('span', { class: 'mono', text: s.fullDay ? '整日选中' : '部分选中' })),
    el('div', { class: 'mini-row' }, el('span', { class: 'k', text: '重叠时长' }), el('span', { class: 'mono', text: fmtHours(s.overlapUs / 3.6e9) })),
    el('div', { class: 'mini-row' }, el('span', { class: 'k', text: '占分区比例' }), el('span', { class: 'mono', text: fmtPct(s.coverageRatio) })),
  ));
  const list = el('div', { class: 'mini-list' });
  s.intervals.forEach((iv, idx) => {
    list.append(el('div', { class: 'mini-row' },
      el('span', { class: 'k' },
        el('b', { text: `#${idx + 1} ` }),
        fmtUtcFromUs(iv.loUs), ' → ', fmtUtcFromUs(iv.hiUs)),
      el('span', { class: 'mono', text: iv.loLocal ? iv.loLocal.slice(0, 16) : fmtHours((iv.hiUs - iv.loUs) / 3.6e9) }),
    ));
    if (iv.loLocal) {
      list.append(el('div', { class: 'mini-row', style: { borderBottom: '0', paddingTop: '0' } },
        el('span', { class: 'k', text: `本地 ${iv.loLocal.slice(0, 16)} → ${iv.hiLocal.slice(0, 16)}` }),
        el('span', { class: 'mono', text: fmtHours((iv.hiUs - iv.loUs) / 3.6e9) }),
      ));
    }
  });
  host.append(list);
}

// ---------------------------------------------------------------------------
// Local day anatomy
// ---------------------------------------------------------------------------

function renderAnatomy(d) {
  const host = clear($('#anatomy'));
  if (!d.anatomy.length) {
    host.append(el('div', { class: 'empty-state', text: '按 UTC 直读模式不计算本地日解剖；切回“时区感知”可查看。' }));
    return;
  }
  for (const a of d.anatomy) {
    const current = a.dayKey === d.dayKey;
    const card = el('div', { class: `anatomy-card ${current ? 'current' : ''}` },
      el('div', { class: 'ad' },
        el('span', {}, a.dayKey, current ? el('span', { class: 'hint', text: ' （本分区所属 UTC 日）' }) : null),
        a.midnightStatus === 'normal'
          ? el('span', { class: 'hint', text: '午夜唯一' })
          : el('span', { class: `badge-pill ${a.midnightStatus === 'skipped' ? 'gap' : 'fold'}`, text: a.midnightStatus === 'skipped' ? '无午夜' : '两次午夜' }),
      ),
      el('div', { class: 'len', text: fmtHours(a.lengthHours) }),
      el('div', { class: 'lo', text: `${a.startLocal}` }),
      el('div', { class: 'lo', text: `→ ${a.endLocal}` }),
    );
    if (a.transitions.length) {
      for (const tr of a.transitions) {
        card.append(el('div', { class: 'lo', style: { marginTop: '6px', color: 'var(--series-2)' },
          text: `${tr.kind === 'gap' ? '跳变' : '回拨'} ${tr.deltaSec > 0 ? '+' : ''}${tr.deltaSec / 60} 分 @ ${fmtUtcFromUs(tr.atUs).slice(11, 19)}Z`,
        }));
      }
    }
    bindTip(card, () => a.dayKey, () => [
      ['日长', fmtHours(a.lengthHours)],
      ['日首', a.startLocal],
      ['日尾', a.endLocal],
      ['午夜', a.midnightStatus === 'normal' ? '1 次' : a.midnightStatus === 'skipped' ? '不存在' : `${a.midnightOccurrences.length} 次`],
    ]);
    host.append(card);
  }
}

function renderTransitions(d) {
  const host = clear($('#transitions'));
  if (!d.transitions.length) {
    host.append(el('div', { class: 'hint', text: '本分区内没有 UTC 偏移跳变；本地时间相对 UTC 是常数平移。' }));
    return;
  }
  host.append(el('div', { class: 'hint', text: '本分区内的偏移跳变', style: { marginBottom: '8px' } }));
  const notes = el('div', { class: 'note-list' });
  for (const tr of d.transitions) {
    notes.append(el('div', { class: 'note warn' }, el('span', { class: 'dot' }),
      el('span', {},
        `UTC ${fmtUtcFromUs(tr.atUs)}：偏移 ${fmtOffsetSec(tr.fromOffset)} → ${fmtOffsetSec(tr.toOffset)}，`,
        `本地时间 ${tr.localBefore.slice(0, 19)} → ${tr.localAfter.slice(0, 19)}。`,
        tr.kind === 'gap' ? ' 这一段本地墙钟不存在。' : ' 这一段本地墙钟重复出现。',
      ),
    ));
  }
  host.append(notes);
}

function fmtOffsetSec(sec) {
  const sign = sec < 0 ? '-' : '+';
  const abs = Math.abs(sec);
  return `${sign}${String(Math.floor(abs / 3600)).padStart(2, '0')}:${String(Math.floor((abs % 3600) / 60)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Hour histograms
// ---------------------------------------------------------------------------

function renderHours(d) {
  const host = clear($('#hours-charts'));
  const hint = $('#hours-hint');
  const totalRows = d.partition.rowCount;
  hint.textContent = `${fmtInt(totalRows)} 行 · 柱高按行数`;

  if (state.hoursView === 'table') {
    host.append(hoursTable(d));
    return;
  }

  // --- UTC hour chart: 24 fixed buckets, single series.
  host.append(chartBlock({
    title: 'UTC 小时（分区坐标，固定 24 桶）',
    subtitle: '分区按 UTC 日切分，因此这里恒为 24 根柱',
    bars: d.utcHours.map((h, idx) => ({
      label: String(idx),
      value: h.rows,
      cls: '',
      tip: [`${String(idx).padStart(2, '0')}:00Z – ${String(idx).padStart(2, '0')}:59Z`, `${fmtInt(h.rows)} 行 · ${fmtBytes(h.bytes)} · ${fmtInt(h.errors)} 错误`],
      title: `${d.dayKey} ${String(idx).padStart(2, '0')}:00Z`,
    })),
    legend: null,
    axisGapTest: null,
  }));

  // --- Local hour chart: one bar per (local day, hour, offset) bucket.
  const hourCount = new Map();
  for (const b of d.localHours) {
    const k = `${b.dayKey} ${b.hour}`;
    hourCount.set(k, (hourCount.get(k) ?? 0) + 1);
  }
  // Walk each local day hour-by-hour so a spring-forward gap shows as a
  // "missing" slot instead of the neighbours silently closing up.
  const order = [];
  const byDayHours = new Map();
  for (const b of d.localHours) {
    if (!byDayHours.has(b.dayKey)) byDayHours.set(b.dayKey, new Map());
    const m = byDayHours.get(b.dayKey);
    if (!m.has(b.hour)) m.set(b.hour, []);
    m.get(b.hour).push(b);
  }
  let missingCount = 0;
  for (const [dayKey, hours] of byDayHours) {
    const min = Math.min(...hours.keys());
    const max = Math.max(...hours.keys());
    for (let h = min; h <= max; h += 1) {
      const buckets = hours.get(h);
      if (!buckets) {
        missingCount += 1;
        order.push({
          kind: 'missing',
          label: `${dayKey.slice(5)} ${String(h).padStart(2, '0')}`,
          title: `${dayKey} ${String(h).padStart(2, '0')}:00（本地不存在）`,
          tip: [`${dayKey} ${String(h).padStart(2, '0')}:00`, '春季跳变：这个本地小时不存在', '0 行'],
          value: 0,
          cls: 'missing',
        });
        continue;
      }
      for (const b of buckets) {
        const repeated = hourCount.get(`${b.dayKey} ${b.hour}`) > 1;
        const hh = String(b.hour).padStart(2, '0');
        order.push({
          kind: 'hour',
          label: `${b.dayKey.slice(5)} ${hh}`,
          title: `${b.dayKey} ${hh}:00 ${b.offset}`,
          tip: [
            `${b.dayKey} ${hh}:00–${hh}:59 ${b.offset}`,
            `${fmtInt(b.rows)} 行 · ${fmtBytes(b.bytes)} · ${fmtInt(b.errors)} 错误`,
            repeated ? '该墙钟小时重复出现（回拨）' : '',
          ].filter(Boolean),
          value: b.rows,
          cls: repeated ? 'repeat' : '',
        });
      }
    }
  }
  host.append(chartBlock({
    title: '本地小时（查询时区，随跳变伸缩）',
    subtitle: `${d.zone} · ${order.filter((b) => b.kind === 'hour').length} 个非空桶${missingCount ? ` · ${missingCount} 个本地小时不存在` : ''}`,
    bars: order,
    legend: [
      { cls: '', label: '正常小时' },
      { cls: 'repeat', label: '重复出现的小时' },
      ...(missingCount ? [{ cls: 'missing', label: '不存在的小时' }] : []),
    ],
  }));

  // Local-day summary of the partition.
  if (d.localDays.length) {
    const list = el('div', { class: 'mini-list', style: { marginTop: '16px' } });
    list.append(el('div', { class: 'hint', text: '本分区的行按本地日期归属', style: { marginBottom: '4px' } }));
    for (const ld of d.localDays) {
      list.append(el('div', { class: 'mini-row' },
        el('span', { class: 'k', text: ld.dayKey }),
        el('span', { class: 'mono', text: `${fmtInt(ld.rows)} 行 · ${fmtBytes(ld.bytes)}${ld.firstLocal ? ` · ${ld.firstLocal.slice(11, 19)} → ${ld.lastLocal.slice(11, 19)}` : ''}` }),
      ));
    }
    host.append(list);
  }
}

function chartBlock({ title, subtitle, bars, legend }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const host = el('div', { class: 'hours', style: { marginBottom: '20px' } },
    el('div', {}, el('div', { style: { fontSize: '12.5px', fontWeight: '600' }, text: title }), el('div', { class: 'hint', text: subtitle, style: { fontSize: '11.5px' } })),
  );
  const chart = el('div', { class: 'hour-chart' });
  chart.style.setProperty('--n', String(bars.length));
  bars.forEach((b) => {
    const bar = el('div', { class: `hb ${b.cls}`, style: { height: `${Math.max(b.value > 0 ? 2 : 1, (b.value / max) * 100)}%` } });
    bindTip(bar, () => b.title, () => b.tip.map((line, idx) => (idx === 0 ? ['', line] : ['', line])));
    chart.append(bar);
  });
  host.append(chart);
  const axis = el('div', { class: 'hour-axis' });
  axis.style.setProperty('--n', String(bars.length));
  const step = Math.max(1, Math.ceil(bars.length / 26));
  bars.forEach((b, idx) => axis.append(el('span', { class: b.cls === 'missing' ? 'gap' : '', text: idx % step === 0 ? b.label : '' })));
  host.append(axis);
  if (legend) {
    const lg = el('div', { class: 'hour-legend' });
    for (const item of legend) {
      lg.append(el('span', {}, el('i', { style: { background: item.cls === 'repeat' ? 'var(--series-2)' : item.cls === 'missing' ? 'var(--surface-3)' : 'var(--series-1)' } }), item.label));
    }
    host.append(lg);
  }
  return host;
}

function hoursTable(d) {
  const wrap = el('div');
  const mk = (title, head, rows) => {
    const table = el('table', { class: 'rec-table' });
    table.append(el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { class: h.num ? 'num' : '', text: h.label })))));
    const body = el('tbody');
    for (const r of rows) {
      body.append(el('tr', {}, ...r.map((c, i) => el('td', { class: head[i].num ? 'num' : i === 0 ? 'mono' : '', text: String(c) }))));
    }
    table.append(body);
    wrap.append(el('div', { class: 'hint', text: title, style: { margin: '6px 0' } }), el('div', { class: 'table-scroll', style: { maxHeight: '320px' } }, table));
  };
  mk('UTC 小时', [{ label: '小时' }, { label: '行数', num: true }, { label: '字节', num: true }, { label: '错误', num: true }],
    d.utcHours.map((h, idx) => [`${String(idx).padStart(2, '0')}:00Z`, fmtInt(h.rows), fmtInt(h.bytes), fmtInt(h.errors)]));
  mk('本地小时', [{ label: '本地小时' }, { label: '偏移' }, { label: '行数', num: true }, { label: '字节', num: true }, { label: '错误', num: true }],
    d.localHours.map((b) => [`${b.dayKey} ${String(b.hour).padStart(2, '0')}:00`, b.offset, fmtInt(b.rows), fmtInt(b.bytes), fmtInt(b.errors)]));
  return wrap;
}

// ---------------------------------------------------------------------------
// Three-way reconciliation
// ---------------------------------------------------------------------------

function renderReconciliation(d) {
  const host = clear($('#reconciliation'));
  const r = d.reconciliation;
  const metrics = [
    ['count', '行数'],
    ['sumBytes', '合计字节'],
    ['sumLatencyMs', '合计延迟 ms'],
    ['errorCount', '错误行'],
  ];
  const table = el('table', { class: 'rec-table' });
  table.append(el('thead', {}, el('tr', {},
    el('th', { text: '指标' }),
    el('th', { class: 'num', text: 'manifest' }),
    el('th', { class: 'num', text: 'buckets' }),
    el('th', { class: 'num', text: 'row scan' }),
    el('th', { text: '一致' }),
  )));
  const body = el('tbody');
  let allAgree = true;
  for (const [key, label] of metrics) {
    const a = r.manifest[key];
    const b = r.buckets[key];
    const c = r.rowScan[key];
    const agree = a === b && b === c;
    if (!agree) allAgree = false;
    body.append(el('tr', {},
      el('td', { class: 'name', text: label }),
      el('td', { class: 'num', text: fmtInt(a) }),
      el('td', { class: 'num', text: fmtInt(b) }),
      el('td', { class: 'num', text: fmtInt(c) }),
      el('td', { class: agree ? 'agree' : 'disagree', text: agree ? '✓ 全等' : '✕ 有差异' }),
    ));
  }
  table.append(body);

  host.append(el('div', { class: `verdict ${allAgree ? 'ok' : 'bad'}`, style: { marginBottom: '12px' } },
    el('span', { class: 'badge', text: allAgree ? '✓' : '✕' }),
    el('span', { text: allAgree ? '分区聚合与逐行计算逐项一致' : '存在不一致，逐项见下表' }),
  ));
  host.append(el('div', { class: 'table-scroll', style: { maxHeight: 'none' } }, table));
  host.append(el('div', { class: 'hint', style: { marginTop: '10px' },
    text: `manifest 来自分区清单（零行读取）；buckets 来自 ${fmtInt(r.buckets.buckets)} 个分钟桶；row scan 直接遍历 ${fmtInt(r.rowScan.count)} 行。三条路径互不依赖。`,
  }));
}

// ---------------------------------------------------------------------------
// Boundary rows
// ---------------------------------------------------------------------------

function renderBoundary(d) {
  const host = clear($('#boundary'));
  const mk = (title, rows) => {
    const box = el('div');
    box.append(el('div', { class: 'hint', text: title, style: { marginBottom: '6px' } }));
    const list = el('div', { class: 'mini-list' });
    for (const row of rows) {
      list.append(el('div', { class: 'mini-row' },
        el('span', { class: 'k' }, `#${row.id} `, el('span', { class: 'mono', text: row.utc })),
        el('span', {}, levelBadge(row.level)),
      ));
      if (row.local) {
        list.append(el('div', { class: 'mini-row', style: { borderBottom: '0', paddingTop: '0', marginTop: '-4px' } },
          el('span', { class: 'k', text: `本地 ${row.local}` }),
          el('span', { class: 'mono', text: row.service }),
        ));
      }
    }
    box.append(list);
    return box;
  };
  host.append(mk('最早三行', d.boundaryRows.first));
  host.append(mk('最晚三行', d.boundaryRows.last));
}
