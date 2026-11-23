const DATA_URL = './data/jobs.json';
const CITY_PREVIEW_LIMIT = 6;
const SEARCH_DEBOUNCE_MS = 120;
const STALE_HOURS = 24;

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
  topbarTime: document.getElementById('topbar-time'),
  statTotal: document.getElementById('stat-total'),
  statAi: document.getElementById('stat-ai'),
  statGame: document.getElementById('stat-game'),
  statIntern: document.getElementById('stat-intern'),
  filters: document.getElementById('filters'),
  filterPanel: document.getElementById('filter-panel'),
  filterToggle: document.getElementById('filter-toggle'),
  filterBadge: document.getElementById('filter-badge'),
  filterClear: document.getElementById('filter-clear'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  error: document.getElementById('error'),
  errorHint: document.getElementById('error-hint'),
  skeleton: document.getElementById('skeleton'),
  count: document.getElementById('result-count'),
  search: document.getElementById('search'),
  searchClear: document.getElementById('search-clear'),
  searchKbd: document.getElementById('search-kbd'),
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

function dotSep() {
  const d = document.createElement('span');
  d.className = 'dot-sep';
  return d;
}

/* ---------- 加载 ---------- */

function renderSkeleton() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 8; i += 1) {
    const card = document.createElement('div');
    card.className = 'sk';
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
      '检测到你是直接双击打开的 HTML 文件，浏览器会拦截本地数据请求。请在项目目录执行 python -m http.server 8000，然后访问 127.0.0.1:8000';
  } else {
    el.errorHint.textContent =
      '请检查网络后刷新页面（' + (err && err.message ? err.message : '未知错误') + '）';
  }
}

function countUp(node, target, duration = 700) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || target < 10) {
    node.textContent = String(target);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    node.textContent = String(Math.round(target * eased));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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

/* ---------- 头部 ---------- */

function renderMeta() {
  const total = meta.kept_count ?? allJobs.length;
  const intern = meta.intern_count ?? 0;
  const ai = meta.ai_count ?? 0;
  const game = meta.game_count ?? 0;
  const time = meta.fetched_at_display || '未知时间';

  countUp(el.statTotal, total);
  countUp(el.statAi, ai);
  countUp(el.statGame, game);
  countUp(el.statIntern, intern);

  const stale = isStale(meta.fetched_at);
  el.topbarTime.textContent = stale ? '更新于 ' + time + '（可能不是最新）' : '更新于 ' + time;
}

function isStale(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return Date.now() - t > STALE_HOURS * 3600 * 1000;
}

/* ---------- 筛选 ---------- */

function countMap(items, pick) {
  const map = new Map();
  for (const job of items) {
    for (const v of pick(job)) map.set(v, (map.get(v) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([id, count]) => ({ id, label: id, count }));
}

function chip(label, count, on, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip' + (on ? ' is-on' : '');
  b.textContent = label;
  if (count != null) {
    const c = document.createElement('span');
    c.className = 'chip-n';
    c.textContent = count;
    b.appendChild(c);
  }
  b.addEventListener('click', onClick);
  return b;
}

function makeRow(label, nodes) {
  const row = document.createElement('div');
  row.className = 'filter-row';

  const lab = document.createElement('div');
  lab.className = 'filter-label';
  lab.textContent = label;

  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const n of nodes) chips.appendChild(n);

  row.appendChild(lab);
  row.appendChild(chips);
  return row;
}

function toggleSet(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
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
    makeRow('类型', typeNodes),
    makeRow('城市', cityNodes),
    makeRow('事业群', bgNodes)
  );

  updateBadge();
}

function activeFilterCount() {
  return state.cities.size + state.bgs.size + (state.type !== 'intern' ? 1 : 0);
}

function updateBadge() {
  const n = activeFilterCount();
  el.filterBadge.hidden = n === 0;
  el.filterBadge.textContent = String(n);
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

function tagKey(job) {
  if (job.tags.length === 2) return 'both';
  return job.tags[0] || 'none';
}

function createCard(job) {
  const a = document.createElement('a');
  a.className = 'job';
  a.href = job.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.dataset.tags = tagKey(job);

  const head = document.createElement('div');
  head.className = 'job-head';

  const h = document.createElement('h3');
  h.className = 'job-title';
  h.textContent = job.title;

  head.appendChild(h);
  head.appendChild(svgIcon('M4 12 L12 4 M6 4 L12 4 L12 10', 'job-go'));

  const foot = document.createElement('div');
  foot.className = 'job-foot';

  const tags = document.createElement('div');
  tags.className = 'job-tags';

  if (job.tags.includes('ai')) tags.appendChild(span('AI', 'tag tag-ai'));
  if (job.tags.includes('game')) tags.appendChild(span('游戏', 'tag tag-game'));

  const metaLine = document.createElement('span');
  metaLine.className = 'job-meta';
  if (job.bgs.length) {
    metaLine.appendChild(span(job.bgs[0], 'bg'));
    if (job.bgs.length > 1) metaLine.appendChild(span('+' + (job.bgs.length - 1)));
  }
  if (job.cities.length) {
    if (job.bgs.length) metaLine.appendChild(dotSep());
    metaLine.appendChild(span(job.cities[0]));
    if (job.cities.length > 1) metaLine.appendChild(span('+' + (job.cities.length - 1)));
  }
  const fullMeta = [];
  if (job.bgs.length) fullMeta.push('事业群：' + job.bgs.join(' / '));
  if (job.cities.length) fullMeta.push('城市：' + job.cities.join(' / '));
  if (fullMeta.length) metaLine.title = fullMeta.join('　');
  tags.appendChild(metaLine);

  foot.appendChild(tags);

  const proj = span(job.project, 'job-project');
  proj.title = job.project;
  foot.appendChild(proj);

  a.appendChild(head);
  a.appendChild(foot);
  return a;
}

function render() {
  const jobs = filteredJobs();

  const typeWord = state.type === 'intern' ? '实习' : state.type === 'campus' ? '应届' : '';
  const strong = document.createElement('strong');
  strong.textContent = String(jobs.length);
  el.count.replaceChildren(
    document.createTextNode('找到 '),
    strong,
    document.createTextNode(' 个' + typeWord + '岗位')
  );

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

/* ---------- 交互 ---------- */

function setPanel(open) {
  el.filterPanel.hidden = !open;
  el.filterToggle.setAttribute('aria-expanded', String(open));
}

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

el.filterToggle.addEventListener('click', () => {
  setPanel(el.filterPanel.hidden);
});

el.filterClear.addEventListener('click', () => {
  state.cities.clear();
  state.bgs.clear();
  state.type = 'intern';
  renderFilters();
  render();
});

el.reset.addEventListener('click', resetAll);
el.emptyReset.addEventListener('click', resetAll);

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== el.search && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    el.search.focus();
  }
  if (e.key === 'Escape' && document.activeElement === el.search) {
    el.search.value = '';
    el.searchClear.hidden = true;
    state.q = '';
    el.search.blur();
    render();
  }
});

load();
