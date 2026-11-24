const DATA_URL = './data/jobs.json';
const FAV_KEY = 'tencent-roles:favs';
const SEARCH_DEBOUNCE_MS = 120;
const STALE_HOURS = 24;
const FAMILY_ORDER = ['AI 研究', '技术', '产品', '设计', '市场', '职能'];
const EDU_ORDER = ['大专', '本科', '硕士', '博士'];
const MAJOR_ORDER = [
  '不限', '计算机 / 软件', '电子 / 通信', '设计 / 艺术',
  '数理 / 统计', '金融 / 商科', '人文 / 社科',
];

const state = {
  q: '',
  type: 'all',
  families: new Set(),
  subFamilies: new Set(),
  edus: new Set(),
  majors: new Set(),
  cities: new Set(),
  bgs: new Set(),
  projects: new Set(),
  favOnly: false,
};

let allJobs = [];
let meta = {};
let favs = loadFavs();
let searchTimer = null;
let cityExpanded = false;

const el = {
  time: document.getElementById('topbar-time'),
  statTotal: document.getElementById('stat-total'),
  statAi: document.getElementById('stat-ai'),
  statTech: document.getElementById('stat-tech'),
  statIntern: document.getElementById('stat-intern'),
  groups: document.getElementById('filter-groups'),
  sidebar: document.getElementById('sidebar'),
  mask: document.getElementById('sidebar-mask'),
  sideClose: document.getElementById('sidebar-close'),
  filterOpen: document.getElementById('filter-open'),
  filterCount: document.getElementById('filter-count'),
  filterReset: document.getElementById('filter-reset'),
  activeBar: document.getElementById('active-bar'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  error: document.getElementById('error'),
  errorHint: document.getElementById('error-hint'),
  skeleton: document.getElementById('skeleton'),
  count: document.getElementById('result-count'),
  search: document.getElementById('search'),
  searchClear: document.getElementById('search-clear'),
  seg: document.getElementById('type-seg'),
  reset: document.getElementById('reset'),
  emptyReset: document.getElementById('empty-reset'),
};

const ns = 'http://www.w3.org/2000/svg';

/* ---------- 工具 ---------- */

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

function loadFavs() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveFavs() {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favs]));
  } catch {
    /* 隐私模式忽略 */
  }
}

function countUp(node, target, duration = 650) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || target < 10) {
    node.textContent = String(target);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    node.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function countMap(items, pick) {
  const map = new Map();
  for (const job of items) {
    for (const v of pick(job)) {
      if (!v) continue;
      map.set(v, (map.get(v) || 0) + 1);
    }
  }
  return [...map.entries()].map(([id, count]) => ({ id, count }));
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
      '检测到你是直接双击打开 HTML，浏览器会拦截本地数据请求。请在项目目录执行 python -m http.server 8000 后访问 127.0.0.1:8000';
  } else {
    el.errorHint.textContent =
      '请检查网络后刷新页面（' + (err && err.message ? err.message : '未知错误') + '）';
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

/* ---------- 头部 ---------- */

function renderMeta() {
  const time = meta.fetched_at_display || '未知';
  countUp(el.statTotal, meta.kept_count ?? allJobs.length);
  countUp(el.statAi, meta.families?.find((f) => f.name === 'AI 研究')?.count ?? 0);
  countUp(el.statTech, meta.families?.find((f) => f.name === '技术')?.count ?? 0);
  countUp(el.statIntern, meta.intern_count ?? 0);

  const stale = isStale(meta.fetched_at);
  el.time.textContent = stale ? '更新于 ' + time + '（可能不是最新）' : '更新于 ' + time;
}

function isStale(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return Date.now() - t > STALE_HOURS * 3600 * 1000;
}

/* ---------- 筛选器 ---------- */

function makeGroup(title, note, items, selected, onToggle, opts = {}) {
  const group = document.createElement('div');
  group.className = 'fgroup';

  const head = document.createElement('div');
  head.className = 'fgroup-title';
  head.appendChild(span(title));
  if (note) head.appendChild(span(note, 'fgroup-note'));
  group.appendChild(head);

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'fgroup-empty';
    empty.textContent = opts.emptyText || '暂无可选项';
    group.appendChild(empty);
    return group;
  }

  for (const item of items) {
    const label = document.createElement('label');
    label.className = 'fopt' + (opts.sub ? ' is-sub' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(item.id);
    cb.addEventListener('change', () => onToggle(item.id));

    label.appendChild(cb);
    label.appendChild(span(item.id, 'fopt-name'));
    label.appendChild(span(String(item.count), 'fopt-n'));
    group.appendChild(label);
  }
  return group;
}

function sortByOrder(items, order) {
  return [...items].sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return b.count - a.count;
  });
}

function renderFilters() {
  const groups = [];

  const famItems = sortByOrder(countMap(allJobs, (j) => [j.family]), FAMILY_ORDER);
  groups.push(
    makeGroup('职能', null, famItems, state.families, (id) => {
      if (state.families.has(id)) state.families.delete(id);
      else state.families.add(id);
      // 移除不再属于已选一级的二级选项
      const valid = new Set(
        allJobs.filter((j) => state.families.has(j.family)).map((j) => j.subFamily)
      );
      for (const sub of [...state.subFamilies]) {
        if (!valid.has(sub)) state.subFamilies.delete(sub);
      }
      renderFilters();
      render();
    })
  );

  // 二级：仅展示已选一级下的子类
  if (state.families.size) {
    const pool = allJobs.filter((j) => state.families.has(j.family));
    const subItems = countMap(pool, (j) => [j.subFamily]).sort((a, b) => b.count - a.count);
    groups.push(
      makeGroup('细分方向', null, subItems, state.subFamilies, (id) => {
        if (state.subFamilies.has(id)) state.subFamilies.delete(id);
        else state.subFamilies.add(id);
        renderFilters();
        render();
      }, { sub: true, emptyText: '该职能暂无细分数据' })
    );
  } else {
    groups.push(
      makeGroup('细分方向', null, [], state.subFamilies, () => {}, {
        emptyText: '先勾选一个职能，这里会出现细分方向',
      })
    );
  }

  const eduItems = (meta.edus || []).map((e) => ({ id: e.name, count: e.count }));
  groups.push(
    makeGroup('学历', '未标注也显示', eduItems, state.edus, (id) => {
      toggle(state.edus, id);
      renderFilters();
      render();
    }, { emptyText: 'JD 里暂无学历信息' })
  );

  const majorItems = (meta.majors || [])
    .map((m) => ({ id: m.name, count: m.count }))
    .sort((a, b) => {
      // 「不限」永远置顶，其余按岗位数降序
      if (a.id === '不限') return -1;
      if (b.id === '不限') return 1;
      return b.count - a.count;
    });
  groups.push(
    makeGroup('专业', '未标注也显示', majorItems, state.majors, (id) => {
      toggle(state.majors, id);
      renderFilters();
      render();
    }, { emptyText: 'JD 里暂无专业信息' })
  );

  if (favs.size > 0) {
    groups.push(
      makeGroup('收藏', null, [{ id: '只看收藏', count: favs.size }],
        new Set(state.favOnly ? ['只看收藏'] : []),
        () => {
          state.favOnly = !state.favOnly;
          renderFilters();
          render();
        })
    );
  }

  const allCities = countMap(allJobs, (j) => j.cities).sort((a, b) => b.count - a.count);
  const cityShown = cityExpanded ? allCities : allCities.slice(0, 8);
  const cityGroup = makeGroup(
    '城市',
    allCities.length > 8 && !cityExpanded ? '前 8 个' : null,
    cityShown,
    state.cities,
    (id) => {
      toggle(state.cities, id);
      renderFilters();
      render();
    },
    { emptyText: '暂无城市数据' }
  );
  if (allCities.length > 8 && !cityExpanded) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'filter-clear';
    more.style.marginTop = '5px';
    more.textContent = '显示全部 ' + allCities.length + ' 个';
    more.addEventListener('click', () => {
      cityExpanded = true;
      renderFilters();
    });
    cityGroup.appendChild(more);
  }
  groups.push(cityGroup);

  const bgItems = countMap(allJobs, (j) => j.bgs).sort((a, b) => b.count - a.count);
  groups.push(
    makeGroup('事业群', null, bgItems, state.bgs, (id) => {
      toggle(state.bgs, id);
      renderFilters();
      render();
    })
  );

  const projItems = countMap(allJobs, (j) => [j.project]).sort((a, b) => b.count - a.count);
  groups.push(
    makeGroup('招聘项目', null, projItems, state.projects, (id) => {
      toggle(state.projects, id);
      renderFilters();
      render();
    })
  );

  el.groups.replaceChildren(...groups);
  renderActiveBar();
  renderFilterCount();
}

function toggle(set, id) {
  if (set.has(id)) set.delete(id);
  else set.add(id);
}

/* ---------- 已选条件 ---------- */

function collectActive() {
  const out = [];
  for (const v of state.families) out.push({ dim: 'families', key: v, label: '职能', text: v });
  for (const v of state.subFamilies) out.push({ dim: 'subFamilies', key: v, label: '细分', text: v });
  for (const v of state.edus) out.push({ dim: 'edus', key: v, label: '学历', text: v });
  for (const v of state.majors) out.push({ dim: 'majors', key: v, label: '专业', text: v });
  for (const v of state.cities) out.push({ dim: 'cities', key: v, label: '城市', text: v });
  for (const v of state.bgs) out.push({ dim: 'bgs', key: v, label: '事业群', text: v });
  for (const v of state.projects) out.push({ dim: 'projects', key: v, label: '项目', text: v });
  if (state.favOnly) out.push({ dim: 'favOnly', key: 'fav', label: '收藏', text: '只看收藏' });
  return out;
}

function renderActiveBar() {
  const active = collectActive();
  el.activeBar.hidden = active.length === 0;
  if (!active.length) {
    el.activeBar.replaceChildren();
    return;
  }

  const nodes = active.map((item) => {
    const chip = document.createElement('span');
    chip.className = 'active-chip';
    chip.appendChild(span(item.label + '：' + item.text));
    const x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', '移除 ' + item.text);
    x.textContent = '×';
    x.addEventListener('click', () => {
      if (item.dim === 'favOnly') state.favOnly = false;
      else state[item.dim].delete(item.key);
      renderFilters();
      render();
    });
    chip.appendChild(x);
    return chip;
  });

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'reset-btn';
  clear.textContent = '清空';
  clear.addEventListener('click', resetFilters);
  nodes.push(clear);

  el.activeBar.replaceChildren(...nodes);
}

function activeCount() {
  return (
    state.families.size +
    state.subFamilies.size +
    state.edus.size +
    state.majors.size +
    state.cities.size +
    state.bgs.size +
    state.projects.size +
    (state.favOnly ? 1 : 0)
  );
}

function renderFilterCount() {
  const n = activeCount();
  el.filterCount.hidden = n === 0;
  el.filterCount.textContent = String(n);
}

/* ---------- 列表 ---------- */

function filteredJobs() {
  const q = state.q.trim().toLowerCase();
  return allJobs.filter((job) => {
    if (state.favOnly && !favs.has(job.id)) return false;
    if (state.type !== 'all' && job.type !== state.type) return false;
    if (state.families.size && !state.families.has(job.family)) return false;
    if (state.subFamilies.size && !state.subFamilies.has(job.subFamily)) return false;
    // 学历：JD 里没写要求的岗位一律保留（未标注 = 无限制）
    if (state.edus.size && job.edu && !state.edus.has(job.edu)) return false;
    // 专业：同理，未提取到专业要求的保留
    if (state.majors.size) {
      const mj = job.majors || [];
      if (mj.length && !mj.some((m) => state.majors.has(m))) return false;
    }
    if (state.cities.size && !job.cities.some((c) => state.cities.has(c))) return false;
    if (state.bgs.size && !job.bgs.some((b) => state.bgs.has(b))) return false;
    if (state.projects.size && !state.projects.has(job.project)) return false;
    if (q && !job.title.toLowerCase().includes(q)) return false;
    return true;
  });
}

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

  const isFav = favs.has(job.id);
  const favBtn = document.createElement('button');
  favBtn.type = 'button';
  favBtn.className = 'fav' + (isFav ? ' is-on' : '');
  favBtn.setAttribute('aria-label', isFav ? '取消收藏' : '收藏');
  favBtn.setAttribute('aria-pressed', String(isFav));

  const star = document.createElementNS(ns, 'svg');
  star.setAttribute('viewBox', '0 0 16 16');
  const starPath = document.createElementNS(ns, 'path');
  starPath.setAttribute(
    'd',
    'M8 1.8 L9.85 5.65 L14.1 6.27 L11.05 9.25 L11.77 13.5 L8 11.5 L4.23 13.5 L4.95 9.25 L1.9 6.27 L6.15 5.65 Z'
  );
  starPath.setAttribute('fill', isFav ? 'currentColor' : 'none');
  starPath.setAttribute('stroke', 'currentColor');
  starPath.setAttribute('stroke-width', '1.3');
  starPath.setAttribute('stroke-linejoin', 'round');
  star.appendChild(starPath);
  favBtn.appendChild(star);

  favBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const on = favs.has(job.id);
    if (on) favs.delete(job.id);
    else favs.add(job.id);
    saveFavs();

    if (state.favOnly) {
      renderFilters();
      render();
    } else {
      favBtn.classList.toggle('is-on', !on);
      favBtn.setAttribute('aria-pressed', String(!on));
      favBtn.setAttribute('aria-label', !on ? '取消收藏' : '收藏');
      starPath.setAttribute('fill', !on ? 'currentColor' : 'none');
      renderFilters();
    }
  });

  head.appendChild(h);
  head.appendChild(favBtn);
  head.appendChild(svgIcon('M4 12 L12 4 M6 4 L12 4 L12 10', 'job-go'));

  const foot = document.createElement('div');
  foot.className = 'job-foot';

  const tags = document.createElement('div');
  tags.className = 'job-tags';

  if (job.family) tags.appendChild(span(job.family, 'tag tag-family'));
  if (job.tags.includes('game')) tags.appendChild(span('游戏', 'tag tag-game'));
  if (job.edu) tags.appendChild(span(job.edu, 'tag tag-edu'));

  const metaLine = document.createElement('span');
  metaLine.className = 'job-meta';

  if (job.subFamily) metaLine.appendChild(span(job.subFamily));
  if (job.bgs.length) {
    if (job.subFamily) metaLine.appendChild(dotSep());
    metaLine.appendChild(span(job.bgs[0], 'bg'));
    if (job.bgs.length > 1) metaLine.appendChild(span('+' + (job.bgs.length - 1)));
  }
  if (job.cities.length) {
    metaLine.appendChild(dotSep());
    metaLine.appendChild(span(job.cities[0]));
    if (job.cities.length > 1) metaLine.appendChild(span('+' + (job.cities.length - 1)));
  }
  const fullMeta = [];
  if (job.subFamily) fullMeta.push('细分：' + job.subFamily);
  if (job.bgs.length) fullMeta.push('事业群：' + job.bgs.join(' / '));
  if (job.cities.length) fullMeta.push('城市：' + job.cities.join(' / '));
  if (fullMeta.length) metaLine.title = fullMeta.join('　');
  tags.appendChild(metaLine);

  foot.appendChild(tags);
  foot.appendChild(span(job.project, 'job-project'));

  a.appendChild(head);
  a.appendChild(foot);
  return a;
}

function render() {
  const jobs = filteredJobs();

  const strong = document.createElement('strong');
  strong.textContent = String(jobs.length);
  const parts = [
    document.createTextNode('找到 '),
    strong,
    document.createTextNode(' 个岗位'),
  ];

  // 学历/专业是「未标注即不限」的通配逻辑，这里说清有多少是真写了要求的
  const hints = [];
  if (state.edus.size) {
    hints.push(jobs.filter((j) => j.edu).length + ' 个明确写了学历');
  }
  if (state.majors.size) {
    hints.push(jobs.filter((j) => (j.majors || []).length).length + ' 个明确写了专业');
  }
  if (hints.length) {
    parts.push(document.createTextNode('，其中 ' + hints.join('、')));
  }
  el.count.replaceChildren(...parts);

  if (!jobs.length) {
    el.list.replaceChildren();
    el.empty.hidden = false;
    return;
  }

  el.empty.hidden = true;

  // 有学历/专业筛选时把带标注的排前面，避免用户以为筛选没生效
  let ordered = jobs;
  if (state.edus.size || state.majors.size) {
    const score = (j) =>
      (state.edus.size && j.edu ? 1 : 0) +
      (state.majors.size && (j.majors || []).length ? 1 : 0);
    ordered = [...jobs].sort((a, b) => score(b) - score(a));
  }

  const frag = document.createDocumentFragment();
  for (const job of ordered) frag.appendChild(createCard(job));
  el.list.replaceChildren(frag);
}

/* ---------- 交互 ---------- */

function resetFilters() {
  state.families.clear();
  state.subFamilies.clear();
  state.edus.clear();
  state.majors.clear();
  state.cities.clear();
  state.bgs.clear();
  state.projects.clear();
  state.favOnly = false;
  renderFilters();
  render();
}

function resetAll() {
  state.q = '';
  state.type = 'all';
  el.search.value = '';
  el.searchClear.hidden = true;
  for (const b of el.seg.querySelectorAll('.seg')) {
    const active = b.dataset.type === 'all';
    b.classList.toggle('is-active', active);
  }
  resetFilters();
}

function setDrawer(open) {
  el.sidebar.classList.toggle('is-open', open);
  el.mask.hidden = !open;
  el.filterOpen.setAttribute('aria-expanded', String(open));
  document.body.style.overflow = open ? 'hidden' : '';
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

el.seg.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg');
  if (!btn) return;
  state.type = btn.dataset.type;
  for (const b of el.seg.querySelectorAll('.seg')) {
    b.classList.toggle('is-active', b === btn);
  }
  render();
});

el.filterOpen.addEventListener('click', () => setDrawer(true));
el.sideClose.addEventListener('click', () => setDrawer(false));
el.mask.addEventListener('click', () => setDrawer(false));

el.filterReset.addEventListener('click', resetFilters);
el.reset.addEventListener('click', resetAll);
el.emptyReset.addEventListener('click', resetAll);

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== el.search && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    el.search.focus();
  }
  if (e.key === 'Escape') {
    if (el.sidebar.classList.contains('is-open')) setDrawer(false);
    else if (document.activeElement === el.search) {
      el.search.value = '';
      el.searchClear.hidden = true;
      state.q = '';
      el.search.blur();
      render();
    }
  }
});

load();
