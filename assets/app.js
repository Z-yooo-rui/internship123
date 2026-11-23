const DATA_URL = './data/jobs.json';
const CITY_PREVIEW_LIMIT = 8;
const SEARCH_DEBOUNCE_MS = 120;
const STALE_HOURS = 24;

const STATE_TYPE_LABEL = { intern: '实习', campus: '应届', other: '其他' };
const state = {
  q: '',
  tab: 'all',
  type: 'intern',
  cities: new Set(),
  bgs: new Set(),
};

let allJobs = [];
let meta = {};
let cityExpanded = false;
let searchTimer = null;

const el = {
  meta: document.getElementById('meta-line'),
  filters: document.getElementById('filters'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  error: document.getElementById('error'),
  errorHint: document.getElementById('error-hint'),
  skeleton: document.getElementById('skeleton'),
  count: document.getElementById('result-count'),
  search: document.getElementById('search'),
  searchClear: document.getElementById('search-clear'),
  tabs: document.getElementById('tabs'),
  reset: document.getElementById('reset'),
  emptyReset: document.getElementById('empty-reset'),
};

const ns = 'http://www.w3.org/2000/svg';

function svgIcon(pathD, cls) {
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', pathD);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.6');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p);
  return svg;
}

function span(text, cls) {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
}

function sep() {
  const s = document.createElement('span');
  s.className = 'sep';
  return s;
}

/* ---------- 加载 ---------- */

function renderSkeleton() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 6; i += 1) {
    const card = document.createElement('div');
    card.className = 'sk-card';
    frag.appendChild(card);
  }
  el.skeleton.replaceChildren(frag);
}

function showError(err) {
  el.error.hidden = false;
  el.skeleton.hidden = true;
  el.list.hidden = true;
  if (location.protocol === 'file:') {
    el.errorHint.textContent =
      '检测到你是直接双击打开的 HTML 文件，浏览器会拦截本地数据请求。请用本地服务器访问，例如在项目目录执行 python -m http.server 8000';
  } else {
    el.errorHint.textContent = '请检查网络后刷新页面（' + (err && err.message ? err.message : '未知错误') + '）';
  }
}

async function load() {
  renderSkeleton();
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    meta = data.meta || {};
    allJobs = Array.isArray(data.jobs) ? data.jobs : [];
    if (!allJobs.length) throw new Error('数据文件为空');

    el.skeleton.hidden = true;
    renderMeta();
    renderFilters();
    render();
  } catch (err) {
    showError(err);
  }
}

/* ---------- 头部信息 ---------- */

function renderMeta() {
  const total = meta.kept_count ?? allJobs.length;
  const intern = meta.intern_count ?? 0;
  const ai = meta.ai_count ?? 0;
  const game = meta.game_count ?? 0;
  const time = meta.fetched_at_display || '未知时间';

  el.meta.replaceChildren();
  el.meta.appendChild(document.createTextNode('共 '));
  el.meta.appendChild(span(String(total), 'meta-strong'));
  el.meta.appendChild(document.createTextNode(' 个岗位 · 实习 ' + intern + ' 个 · AI ' + ai + ' · 游戏 ' + game + ' · 更新于 ' + time));

  const stale = isStale(meta.fetched_at);
  if (stale) {
    const warn = document.createElement('div');
    warn.className = 'meta-warn';
    warn.textContent = '数据已超过 ' + STALE_HOURS + ' 小时未更新，可能不是最新，请以腾讯官网为准';
    el.meta.appendChild(warn);
  }
}

function isStale(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return Date.now() - t > STALE_HOURS * 3600 * 1000;
}

/* ---------- 筛选器 ---------- */

function countMap(items, pick) {
  const map = new Map();
  for (const job of items) {
    for (const v of pick(job)) {
      map.set(v, (map.get(v) || 0) + 1);
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([id, count]) => ({ id, label: id, count }));
}

function chip(label, count, on, onClick, extraClass) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip' + (on ? ' is-on' : '') + (extraClass ? ' ' + extraClass : '');
  b.textContent = label;
  if (count != null) {
    const c = document.createElement('span');
    c.className = 'chip-count';
    c.textContent = count;
    b.appendChild(c);
  }
  b.addEventListener('click', onClick);
  return b;
}

function makeGroup(label, nodes) {
  const group = document.createElement('div');
  group.className = 'filter-group';
  const lab = document.createElement('div');
  lab.className = 'filter-label';
  lab.textContent = label;
  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const n of nodes) chips.appendChild(n);
  group.appendChild(lab);
  group.appendChild(chips);
  return group;
}

function renderFilters() {
  const typeItems = [
    { id: 'intern', label: '实习', count: allJobs.filter((j) => j.type === 'intern').length },
    { id: 'campus', label: '应届', count: allJobs.filter((j) => j.type === 'campus').length },
    { id: 'all', label: '不限', count: allJobs.length },
  ];
  const typeNodes = typeItems.map((it) =>
    chip(it.label, it.count, state.type === it.id, () => {
      state.type = it.id;
      renderFilters();
      render();
    })
  );

  const cityItems = countMap(allJobs, (j) => j.cities);
  const cityShown = cityExpanded ? cityItems : cityItems.slice(0, CITY_PREVIEW_LIMIT);
  const cityNodes = cityShown.map((it) =>
    chip(it.label, it.count, state.cities.has(it.id), () => {
      toggleSet(state.cities, it.id);
      renderFilters();
      render();
    })
  );
  if (cityItems.length > CITY_PREVIEW_LIMIT) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'chip-more';
    more.textContent = cityExpanded ? '收起' : '展开全部 ' + cityItems.length;
    more.addEventListener('click', () => {
      cityExpanded = !cityExpanded;
      renderFilters();
    });
    cityNodes.push(more);
  }

  const bgItems = countMap(allJobs, (j) => j.bgs);
  const bgNodes = bgItems.map((it) =>
    chip(it.label, it.count, state.bgs.has(it.id), () => {
      toggleSet(state.bgs, it.id);
      renderFilters();
      render();
    })
  );

  el.filters.replaceChildren(
    makeGroup('类型', typeNodes),
    makeGroup('城市', cityNodes),
    makeGroup('事业群', bgNodes)
  );
}

function toggleSet(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

/* ---------- 列表 ---------- */

function filteredJobs() {
  const q = state.q.trim().toLowerCase();
  return allJobs.filter((job) => {
    if (state.tab !== 'all' && !job.tags.includes(state.tab)) return false;
    if (state.type !== 'all' && job.type !== state.type) return false;
    if (state.cities.size && !job.cities.some((c) => state.cities.has(c))) return false;
    if (state.bgs.size && !job.bgs.some((b) => state.bgs.has(b))) return false;
    if (q && !job.title.toLowerCase().includes(q)) return false;
    return true;
  });
}

function createCard(job) {
  const a = document.createElement('a');
  a.className = 'job';
  a.href = job.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';

  const top = document.createElement('div');
  top.className = 'job-top';

  const h = document.createElement('h3');
  h.className = 'job-title';
  h.textContent = job.title;
  top.appendChild(h);
  top.appendChild(svgIcon('M4 12 L12 4 M6 4 L12 4 L12 10', 'job-arrow'));

  const metaRow = document.createElement('div');
  metaRow.className = 'job-meta';

  if (job.tags.includes('ai')) {
    const t = span('AI', 'tag tag-ai');
    metaRow.appendChild(t);
  }
  if (job.tags.includes('game')) {
    metaRow.appendChild(span('游戏', 'tag tag-game'));
  }
  metaRow.appendChild(span(job.project, 'tag tag-type'));

  if (job.bgs.length) {
    metaRow.appendChild(sep());
    const bgText = job.bgs.slice(0, 2).join(' / ') + (job.bgs.length > 2 ? ' +' + (job.bgs.length - 2) : '');
    metaRow.appendChild(span(bgText, 'job-bg'));
  }

  if (job.cities.length) {
    metaRow.appendChild(sep());
    const cityText =
      job.cities.slice(0, 2).join(' / ') + (job.cities.length > 2 ? ' +' + (job.cities.length - 2) : '');
    metaRow.appendChild(span(cityText));
  }

  a.appendChild(top);
  a.appendChild(metaRow);
  return a;
}

function render() {
  const jobs = filteredJobs();

  el.count.replaceChildren();
  el.count.appendChild(document.createTextNode('找到 '));
  el.count.appendChild(span(String(jobs.length), 'meta-strong'));
  el.count.appendChild(document.createTextNode(' 个岗位'));

  if (!jobs.length) {
    el.list.replaceChildren();
    el.empty.hidden = false;
    return;
  }

  el.empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const job of jobs) frag.appendChild(createCard(job));
  el.list.replaceChildren(frag);
}

/* ---------- 交互绑定 ---------- */

function resetAll() {
  state.q = '';
  state.tab = 'all';
  state.type = 'intern';
  state.cities.clear();
  state.bgs.clear();
  el.search.value = '';
  el.searchClear.hidden = true;
  for (const t of el.tabs.querySelectorAll('.tab')) {
    const active = t.dataset.tab === 'all';
    t.classList.toggle('is-active', active);
    t.setAttribute('aria-selected', String(active));
  }
  renderFilters();
  render();
}

el.search.addEventListener('input', (e) => {
  const value = e.target.value;
  el.searchClear.hidden = !value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = value;
    render();
  }, SEARCH_DEBOUNCE_MS);
});

el.searchClear.addEventListener('click', () => {
  el.search.value = '';
  el.searchClear.hidden = true;
  state.q = '';
  el.search.focus();
  render();
});

el.tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  state.tab = btn.dataset.tab;
  for (const t of el.tabs.querySelectorAll('.tab')) {
    const active = t === btn;
    t.classList.toggle('is-active', active);
    t.setAttribute('aria-selected', String(active));
  }
  render();
});

el.reset.addEventListener('click', resetAll);
el.emptyReset.addEventListener('click', resetAll);

load();
