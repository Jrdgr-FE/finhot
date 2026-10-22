// FinHot front end. One module renders every static route; the server renders
// /articles/* and /daily/<date> itself and only loads style.css and i18n.js.
import { t, locale, language } from './i18n.js';
import { localizeItem, sourceName } from './content-language.js';

const app = document.querySelector('#app');
const path = location.pathname.replace(/\/$/, '') || '/';
const params = new URLSearchParams(location.search);
const hybrid = document.querySelector('meta[name="finhot-edition"]')?.content === 'hybrid';
const en = language === 'en';
const zone = 'Asia/Shanghai';
const groups = { market: t('市场动态'), company: t('上市公司'), research: t('投资研究'), macro: t('政策与宏观'), global: t('海外金融') };
const categories = { policy: t('政策监管'), macro: t('宏观数据'), market: t('市场行情'), earnings: t('财报业绩'), corporate: t('公司事件'), research: t('投资研究'), banking: t('银行'), securities: t('证券'), insurance: t('保险'), fund: t('资管'), institution: t('机构动态'),
  'ai-models': t('模型'), 'ai-products': t('产品与工具'), chips: t('芯片与半导体'), compute: t('算力与数据中心'), robotics: t('机器人'), 'ai-research': t('论文研究'), 'ai-policy': t('政策与安全'), 'ai-opinion': t('观点与实践'), 'ai-business': t('产业与资本') };

// Domains: AI & deep tech and finance. A link's ?domain= wins, then the reader's last explicit switch,
// then finance. Finance links carry no parameter, so its pages and old links stay as they were.
const domainCategories = {
  finance: ['policy', 'macro', 'market', 'earnings', 'corporate', 'research', 'banking', 'securities', 'insurance', 'fund', 'institution'],
  ai: ['ai-models', 'ai-products', 'chips', 'compute', 'robotics', 'ai-research', 'ai-policy', 'ai-opinion', 'ai-business'],
};
const domainNames = { ai: t('AI 与硬科技'), finance: t('金融') };
const domainStore = 'finhot-domain';
const storedDomain = () => { try { return localStorage.getItem(domainStore); } catch { return null; } };
const rememberDomain = value => { try { localStorage.setItem(domainStore, value); } catch { /* Storage can be disabled. */ } };
const domain = [params.get('domain'), storedDomain()].find(value => Object.hasOwn(domainNames, value)) || 'finance';
const isAi = domain === 'ai';
/** A site link in the current domain. */
const inDomain = href => { if (domain === 'finance') return href; const u = new URL(href, location.origin); u.searchParams.set('domain', domain); return u.pathname + u.search + u.hash; };
/** An API request in the current domain (the server answers finance-only until it has more). */
const scoped = href => { const u = new URL(href, location.origin); u.searchParams.set('domain', domain); return u.pathname + u.search; };

const el = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
const link = (text, href, className) => { const a = el('a', text, className); a.href = href; return a; };
const external = (text, href, className) => { const a = link(text, href, className); a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
const han = value => /[㐀-鿿]/u.test(value || '');
const valid = value => !!value && !Number.isNaN(Date.parse(value));
const safeUrl = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : null; } catch { return null; } };
const number = value => new Intl.NumberFormat(locale).format(value || 0);

// Beijing-time formatting. dayKey gives YYYY-MM-DD for comparisons and API dates.
const dayKey = value => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const today = () => dayKey(Date.now());
const clock = value => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const stamp = value => valid(value) ? new Intl.DateTimeFormat(locale, { timeZone: zone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : t('时间待核实');
const longDay = date => new Intl.DateTimeFormat(locale, { timeZone: zone, month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(date + 'T12:00:00+08:00'));

async function api(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), ...options });
  const data = await response.json().catch(() => ({}));
  if (response.status === 400 && data.error === '无效领域' && domain !== 'finance') { rememberDomain('finance'); const u = new URL(location.href); u.searchParams.delete('domain'); location.replace(u.href); }
  if (!response.ok) throw new Error(en && han(data.error) ? t('加载失败，请稍后重试') : data.error || t('加载失败，请稍后重试'));
  if (data.items) data.items = data.items.map(item => localizeItem(item, language));
  if (data.sources) data.sources = data.sources.map(source => ({ ...source, name: sourceName(source.id, source.name, language) }));
  return data;
}
const failure = error => error?.name === 'TimeoutError' || error?.name === 'AbortError' ? t('加载超时，请稍后重试。') : error instanceof TypeError ? t('网络连接失败，请稍后重试。') : error?.message || t('加载失败，请稍后重试');
let reportList;
const reports = () => (reportList ||= api(scoped('/api/reports')).catch(error => { reportList = null; throw error; }));

// api() has already localized every item through content-language.js.
const localize = item => item;
const articleHref = item => hybrid ? '/articles/' + encodeURIComponent(item.id) : safeUrl(item.url) || '#';

function row(raw, { full = false } = {}) {
  const item = localize(raw), article = el('article', undefined, 'feed-row');
  const when = valid(item.published_at) ? item.published_at : valid(item.discovered_at) ? item.discovered_at : null;
  const time = el('time', undefined, 'row-time');
  if (when) {
    const current = dayKey(when) === today();
    // Research reports carry a date only, which arrives as midnight Beijing time.
    const dateOnly = item.published_at && clock(when) === '00:00';
    time.dateTime = when;
    time.title = dateOnly ? t('发布日期') + ' ' + dayKey(when) : (item.published_at ? t('发布时间') : t('收录时间')) + ' ' + stamp(when) + t('（北京时间）');
    if (!current || dateOnly) time.append(el('span', dayKey(when).slice(5)));
    if (!dateOnly) time.append(el('span', clock(when)));
    time.classList.toggle('is-today', current);
  } else time.textContent = '—';
  const body = el('div'), heading = el('h3', undefined, 'row-title'), title = link(item.title, articleHref(item));
  if (!hybrid) { title.target = '_blank'; title.rel = 'noopener noreferrer'; }
  title.lang = han(item.title) ? 'zh-CN' : 'en';
  heading.append(title);
  body.append(heading);
  if (item.summary) {
    const summary = el('p', item.summary, 'row-summary' + (full ? ' is-full' : ''));
    summary.lang = han(item.summary) ? 'zh-CN' : 'en';
    body.append(summary);
  }
  const meta = el('div', undefined, 'row-meta');
  if (item.selected) meta.append(el('span', t('精选'), 'badge badge-accent'));
  meta.append(link(item.source_name, '/all?source=' + encodeURIComponent(item.source_id || ''), 'row-source'));
  if (categories[item.category]) meta.append(el('span', categories[item.category]));
  if (en && item.translation_pending) meta.append(el('span', t('英文译文准备中')));
  const pdf = /^PDF 前 (\d+) 页（共 (\d+) 页）/.exec(item.material_scope || '');
  if (item.summary && pdf) meta.append(el('span', t('摘要基于 PDF 前 {pages}/{total} 页', { pages: pdf[1], total: pdf[2] })));
  const url = safeUrl(item.url);
  if (url && hybrid) meta.append(external(t('原文 ↗'), url, 'row-out'));
  body.append(meta);
  article.append(time, body);
  return article;
}
function skeleton(count = 10) {
  return Array.from({ length: count }, () => {
    const line = el('div', undefined, 'feed-row is-skeleton'), body = el('div');
    line.setAttribute('aria-hidden', 'true');
    body.append(el('span', undefined, 'sk sk-title'), el('span', undefined, 'sk sk-meta'));
    line.append(el('span', undefined, 'sk sk-time'), body);
    return line;
  });
}
function failed(error, retry) {
  const box = el('div', undefined, 'empty');
  box.setAttribute('role', 'alert');
  box.append(el('p', failure(error), 'error'));
  if (retry) { const button = el('button', t('重新加载'), 'btn btn-secondary btn-sm'); button.type = 'button'; button.onclick = retry; box.append(button); }
  return box;
}

let statusBox = null;
/** The domain switch, once the server lists more than one domain; a click is remembered. */
function domainSwitch(head, catalog) {
  if (!Array.isArray(catalog) || catalog.length < 2 || head.querySelector('.domain-switch')) return;
  const nav = el('nav', undefined, 'segmented domain-switch');
  nav.setAttribute('aria-label', t('领域'));
  for (const d of catalog) {
    if (!Object.hasOwn(domainNames, d.key)) continue;
    const u = new URL(location.pathname, location.origin);
    if (path === '/daily' && params.get('date')) u.searchParams.set('date', params.get('date'));
    u.searchParams.set('domain', d.key);
    const a = link(en ? d.labelEn : d.label, u.pathname + u.search, d.key === domain ? 'active' : '');
    if (d.key === domain) a.setAttribute('aria-current', 'page');
    a.addEventListener('click', () => rememberDomain(d.key));
    nav.append(a);
  }
  head.prepend(nav);
}
function pageHead(title, description) {
  const head = el('div', undefined, 'page-head'), copy = el('div');
  copy.append(el('h1', title));
  if (description) copy.append(el('p', description));
  statusBox = el('p', '', 'status');
  statusBox.setAttribute('role', 'status');
  head.append(copy, statusBox);
  app.append(head);
  return head;
}
function showHealth(health) {
  if (!statusBox || !health) return;
  const late = (health.overdueSources || 0) + (health.failedSources || 0);
  statusBox.className = 'status' + (health.stale || late ? ' warning' : '');
  statusBox.textContent = (health.stale ? t('更新有延迟') + ' · ' : '') + (valid(health.syncedAt) ? t('最近同步 {time}', { time: stamp(health.syncedAt) }) : t('同步时间待确认')) + (!health.stale && late ? ' · ' + t('{count} 个信源延迟', { count: late }) : '');
  statusBox.title = health.stale ? t('内容更新暂有延迟，当前展示最近收录的信息。') : late ? t('部分来源更新延迟，请留意原文时间。') : t('时间为北京时间，请结合来源原文阅读。');
}
const refreshHealth = () => { if (hybrid && !document.hidden) api('/api/health').then(showHealth).catch(() => {}); };

// Sidebar cards shared by the homepage and the explorer.
function sideCard(title, action) {
  const card = el('section', undefined, 'panel side-card'), head = el('div', undefined, 'side-head');
  head.append(el('h2', title));
  if (action) head.append(action);
  card.append(head);
  return card;
}
function briefCard() {
  const card = sideCard(t('每日简报'), link(t('往期 →'), inDomain('/daily'))), body = el('div');
  body.append(el('p', t('正在读取最新简报…'), 'hint'));
  card.append(body);
  (async () => {
    try {
      // Most of the day the latest brief is today's, so fetch it alongside the list.
      const guess = api(scoped('/api/reports/' + today())).catch(() => null), latest = (await reports()).reports?.[0];
      if (!latest) { body.replaceChildren(el('p', t('第一份日报将在下一个北京时间 08:00 生成。'), 'hint')); return; }
      const report = (latest.date === today() && await guess) || await api(scoped('/api/reports/' + latest.date)), list = el('ol', undefined, 'brief-list');
      for (const raw of report.items.slice(0, 5)) { const item = localize(raw), li = el('li'); li.append(link(item.title, articleHref(item)), el('small', item.source_name)); list.append(li); }
      const count = { count: report.items.length };
      body.replaceChildren(el('p', longDay(latest.date) + ' · ' + (report.mode === 'source-index' ? t('来源索引 {count} 条', count) : t('精选 {count} 条', count)), 'side-sub'));
      if (report.items.length) body.append(list);
      body.append(link(t('阅读完整简报 →'), inDomain('/daily'), 'text-link'));
    } catch { body.replaceChildren(el('p', t('简报暂时无法加载。'), 'hint'), link(t('打开每日简报 →'), inDomain('/daily'), 'text-link')); }
  })();
  return card;
}
function rankCard() {
  const note = el('span', t('按收录量')), card = sideCard(t('信源排行'), note), list = el('ol', undefined, 'rank-list');
  card.append(list);
  card.update = (sources, group) => {
    note.textContent = group ? (groups[group] || categories[group]) + ' · ' + t('按收录量') : t('按收录量');
    list.replaceChildren(...sources.filter(s => (!group || !groups[group] || s.group === group) && (!s.domains || s.domains.includes(domain))).sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 8).map((source, index) => {
      const li = el('li'), a = link('', '/all?source=' + encodeURIComponent(source.id));
      a.title = source.failed ? t('更新暂有延迟') : valid(source.latest_published_at) ? t('源内最新 {time}', { time: stamp(source.latest_published_at) }) : '';
      a.append(el('span', String(index + 1), 'rank-num'), el('span', source.name, 'rank-name'), el('span', number(source.count), 'rank-count' + (source.failed ? ' is-late' : '')));
      li.append(a);
      return li;
    }));
  };
  return card;
}
function toolCard() {
  const card = sideCard('FinMap ' + t('金融图谱'));
  card.id = 'products';
  card.classList.add('tool-card');
  card.append(el('p', t('查询金融机构，探索股东、子公司与参股关系。')), external(t('打开金融机构图谱 →'), 'https://map.finhot.fun/', 'text-link'));
  return card;
}
function sideNote() {
  const note = el('p', t('摘要由模型辅助生成，请核对来源原文；资讯与研究观点不构成投资建议。') + ' ', 'side-note');
  note.append(link(t('了解收录方式'), '/about'));
  return note;
}

async function home() {
  app.classList.add('page-home');
  const head = pageHead(isAi ? t('最新 AI 与硬科技资讯') : t('最新资讯'));
  // Finance tabs are source groups; AI tabs are categories ('latest' is the whole domain).
  const tabLabels = isAi ? { latest: t('最新'), 'ai-models': categories['ai-models'], chips: categories.chips, compute: categories.compute, 'ai-business': categories['ai-business'] } : groups;
  const keys = isAi ? ['latest', 'ai-models', 'chips', 'compute', 'ai-business'] : ['market', 'company', 'research'], cache = new Map(), first = keys[0];
  const filterOf = key => isAi ? (key === 'latest' ? {} : { category: key }) : { group: key };
  let active = keys.includes(location.hash.slice(1)) ? location.hash.slice(1) : first, sources = null;
  const panel = el('section', undefined, 'panel'), toolbar = el('div', undefined, 'feed-toolbar'), tabs = el('div', undefined, 'segmented');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', t('资讯栏目'));
  const buttons = keys.map(key => { const b = el('button', tabLabels[key]); b.type = 'button'; b.id = key + '-tab'; b.dataset.group = key; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'feed'); return b; });
  tabs.append(...buttons);
  const field = el('label', undefined, 'search-field'), search = el('input');
  search.type = 'search';
  search.maxLength = 80;
  search.placeholder = t('筛选最新标题，回车搜索全部');
  search.setAttribute('aria-label', t('筛选最新标题'));
  field.append(search);
  toolbar.append(tabs, field);
  const feed = el('div', undefined, 'feed'), foot = el('div', undefined, 'panel-foot'), all = link('', '/all', 'text-link'), more = el('button', t('加载更多'), 'btn btn-secondary btn-sm');
  feed.id = 'feed';
  feed.setAttribute('role', 'tabpanel');
  more.type = 'button';
  foot.append(all, more);
  panel.append(toolbar, feed, foot);
  const ranking = rankCard(), side = el('aside', undefined, 'side'), layout = el('div', undefined, 'layout');
  side.append(briefCard(), ranking, toolCard(), sideNote());
  layout.append(panel, side);
  app.append(layout);

  const matches = item => { const query = search.value.trim().toLowerCase(); return !query || [item.title, item.original_title, item.title_en, item.summary, item.summary_en, item.source_name].join(' ').toLowerCase().includes(query); };
  function links() {
    const query = search.value.trim(), q = new URLSearchParams(filterOf(active));
    if (query) q.set('q', query);
    all.href = inDomain('/all' + (q.size ? '?' + q : ''));
    const label = active === 'latest' ? t('{domain}动态', { domain: domainNames[domain] }) : tabLabels[active];
    all.textContent = query ? t('在全部{group}中搜索“{query}” →', { group: label, query }) : t('查看全部{group} →', { group: label });
  }
  function render() {
    const entry = cache.get(active);
    if (!entry) return;
    const items = entry.items.filter(matches);
    feed.removeAttribute('aria-busy');
    feed.replaceChildren(...items.map(item => row(item)));
    if (!items.length) feed.append(el('p', search.value.trim() ? t('最新资讯中没有匹配结果，回车可在全部动态中搜索。') : t('这个栏目暂无资讯，请稍后再来。'), 'empty'));
    more.hidden = !!search.value.trim() || !entry.hasMore;
    links();
  }
  async function page(key, offset) {
    const q = new URLSearchParams({ all: '1', ...filterOf(key), offset: String(offset) });
    if (!sources) q.set('catalog', '1');
    const data = await api(scoped('/api/items?' + q));
    if (data.sources) { sources = data.sources; ranking.update(sources, isAi ? '' : active); }
    if (data.domains) domainSwitch(head, data.domains);
    showHealth(data.health);
    return data;
  }
  async function load(key, quiet = false) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.at < 300000) return render();
    if (!quiet) { feed.setAttribute('aria-busy', 'true'); feed.replaceChildren(...skeleton()); more.hidden = true; }
    try {
      const data = await page(key, 0);
      cache.set(key, { items: data.items, hasMore: data.hasMore, at: Date.now() });
      if (active === key) render();
    } catch (error) {
      if (active !== key || quiet) return;
      feed.removeAttribute('aria-busy');
      feed.replaceChildren(failed(error, () => load(key)));
    }
  }
  function select(key) {
    active = key;
    buttons.forEach(b => { const on = b.dataset.group === key; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    feed.setAttribute('aria-labelledby', key + '-tab');
    history.replaceState(null, '', location.pathname + location.search + (key === first ? '' : '#' + key));
    if (sources) ranking.update(sources, isAi ? '' : key);
    links();
    load(key);
  }
  buttons.forEach((button, index) => {
    button.addEventListener('click', () => { search.value = ''; select(button.dataset.group); });
    button.addEventListener('keydown', event => {
      const next = { ArrowRight: (index + 1) % buttons.length, ArrowLeft: (index + buttons.length - 1) % buttons.length, Home: 0, End: buttons.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      buttons[next].focus();
      buttons[next].click();
    });
  });
  search.addEventListener('input', render);
  search.addEventListener('keydown', event => { if (event.key === 'Enter' && search.value.trim()) location.href = all.href; });
  more.addEventListener('click', async () => {
    const key = active, entry = cache.get(key);
    if (!entry) return;
    more.disabled = true;
    more.textContent = t('正在加载…');
    try {
      const data = await page(key, entry.items.length), seen = new Set(entry.items.map(item => item.id)), fresh = data.items.filter(item => !seen.has(item.id));
      entry.items.push(...fresh);
      entry.hasMore = data.hasMore && fresh.length > 0;
      if (active === key) { feed.append(...fresh.map(item => row(item))); more.hidden = !entry.hasMore; }
      more.textContent = t('加载更多');
    } catch { more.textContent = t('加载失败，点击重试'); }
    finally { more.disabled = false; }
  });
  // Quietly refresh the first page when a reader comes back to an open tab.
  const refresh = () => {
    const entry = cache.get(active);
    if (document.hidden || !entry || Date.now() - entry.at < 300000) return;
    if (search.value.trim() || entry.items.length > 20) return refreshHealth();
    cache.delete(active);
    load(active, true);
  };
  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, 300000);
  select(active);
}

async function explore() {
  const view = ['today', 'selected'].includes(params.get('view')) ? params.get('view') : '';
  // Groups are finance's source columns; a category must belong to the current domain.
  const group = !isAi && groups[params.get('group')] ? params.get('group') : '', source = params.get('source') || '', query = (params.get('q') || '').trim();
  const category = domainCategories[domain].includes(params.get('category')) ? params.get('category') : '';
  const head = pageHead(view === 'selected' ? t('精选摘要') : view === 'today' ? (isAi ? t('今日 AI 与硬科技动态') : t('今日金融动态')) : groups[group] || (isAi && categories[category]) || (isAi ? t('AI 与硬科技动态') : t('金融动态')),
    view === 'selected' ? t('通过精选评审的资讯，保留原文与出处。阅读时请留意来源日期。') : isAi ? t('模型、芯片、算力与机器人，一处发现。选择你关心的方向，沿着原文继续探索。') : t('市场、公司与研究，一处发现。选择你关心的方向，沿着原文继续探索。'));
  const href = changes => { const q = new URLSearchParams(params); if (domain !== 'finance') q.set('domain', domain); for (const [key, value] of Object.entries(changes)) value ? q.set(key, value) : q.delete(key); return '/all' + (q.size ? '?' + q : ''); };

  const toolbar = el('div', undefined, 'toolbar'), top = el('div', undefined, 'toolbar-row'), views = el('nav', undefined, 'segmented');
  views.setAttribute('aria-label', t('浏览方式'));
  for (const [key, label] of [['', t('全部动态')], ['today', t('今日更新')], ['selected', t('精选摘要')]]) {
    const a = link(label, href({ view: key }), key === view ? 'active' : '');
    if (key === view) a.setAttribute('aria-current', 'page');
    views.append(a);
  }
  const form = el('form', undefined, 'search'), input = el('input'), submit = el('button', t('搜索'), 'btn btn-secondary btn-sm');
  form.setAttribute('role', 'search');
  input.type = 'search';
  input.name = 'q';
  input.maxLength = 80;
  input.value = query;
  input.placeholder = t('搜索公司、标题或摘要');
  input.setAttribute('aria-label', t('搜索公司、标题或摘要'));
  form.append(input, submit);
  form.onsubmit = event => { event.preventDefault(); location.href = href({ q: input.value.trim() }); };
  top.append(views, form);
  const scopes = el('div', undefined, 'chips'), kinds = el('div', undefined, 'chips'), ownCategories = domainCategories[domain].map(key => [key, categories[key]]);
  // Finance: source columns up top, categories under the filters. AI: its categories up top.
  if (isAi) for (const [key, label] of [['', t('全部分类')], ...ownCategories]) scopes.append(link(label, href({ category: key, source: '' }), 'chip' + (key === category ? ' active' : '')));
  else for (const [key, label] of [['', t('全部栏目')], ...Object.entries(groups)]) scopes.append(link(label, href({ group: key, source: '' }), 'chip' + (key === group ? ' active' : '')));
  const advanced = el('details', undefined, 'advanced-filters');
  advanced.open = !!(source || (!isAi && category));
  advanced.append(el('summary', isAi ? t('按信源进一步筛选') : t('按分类和信源进一步筛选')));
  if (!isAi) for (const [key, label] of [['', t('全部分类')], ...ownCategories]) kinds.append(link(label, href({ category: key }), 'chip' + (key === category ? ' active' : '')));
  const sourceLabel = el('label', t('信源'), 'source-filter'), picker = el('select'), any = el('option', t('全部信源'));
  any.value = '';
  picker.setAttribute('aria-label', t('筛选信源'));
  picker.append(any);
  picker.onchange = () => { location.href = href({ source: picker.value }); };
  sourceLabel.append(picker);
  advanced.append(kinds, sourceLabel);
  toolbar.append(top, scopes, advanced);
  app.append(toolbar);

  const layout = el('div', undefined, 'layout'), main = el('div', undefined, 'stack'), panel = el('section', undefined, 'panel'), feed = el('div', undefined, 'feed'), foot = el('div', undefined, 'panel-foot');
  const more = el('button', t('加载更多'), 'btn btn-secondary btn-sm'), ranking = rankCard(), side = el('aside', undefined, 'side');
  more.type = 'button';
  panel.append(feed, foot);
  if (group === 'research') main.append(el('p', t('研报中的预测、评级与观点归属于原研究机构，请结合原文独立判断。'), 'notice'));
  main.append(panel);
  side.append(briefCard(), ranking, toolCard(), sideNote());
  layout.append(main, side);
  app.append(layout);
  feed.setAttribute('aria-busy', 'true');
  feed.replaceChildren(...skeleton());

  let range = view === 'today' ? new Date(today() + 'T00:00:00+08:00').toISOString() : '', offset = 0;
  const shown = new Set();
  const request = extra => { const q = new URLSearchParams({ all: view === 'selected' ? '0' : '1', category, group, source, q: query, offset: String(offset), ...extra }); if (range) q.set('from', range); return api(scoped('/api/items?' + q)); };
  function append(data) {
    const fresh = data.items.filter(item => !shown.has(item.id));
    fresh.forEach(item => shown.add(item.id));
    feed.append(...fresh.map(item => row(item)));
    offset += data.items.length;
    foot.replaceChildren();
    if (data.hasMore && fresh.length) foot.append(el('span', t('已显示 {count} 条', { count: shown.size }), 'hint'), more);
    else if (shown.size) foot.append(el('span', t('共 {count} 条', { count: shown.size }), 'hint'));
  }
  async function first() {
    feed.setAttribute('aria-busy', 'true');
    try {
      let data = await request({ catalog: '1' });
      if (view === 'today' && !data.items.length && !category && !group && !source && !query) {
        range = '';
        data = await request({ catalog: '1' });
        main.prepend(el('p', t('今天尚无新收录，以下为最近动态，请留意原文日期。'), 'notice'));
      }
      showHealth(data.health);
      if (data.domains) domainSwitch(head, data.domains);
      const catalog = data.sources || (await api('/api/sources').catch(() => ({ sources: [] }))).sources || [];
      for (const s of catalog.filter(s => (!group || s.group === group) && (!s.domains || s.domains.includes(domain)))) { const option = el('option', s.name); option.value = s.id; picker.append(option); }
      picker.value = source;
      ranking.update(catalog, group);
      feed.replaceChildren();
      feed.removeAttribute('aria-busy');
      if (!data.items.length) feed.append(el('p', query || category || source || group ? t('没有匹配的资讯，试试其他栏目、信源或关键词。') : view === 'selected' ? t('暂时没有入选资讯。你可以先浏览全部动态。') : t('资讯正在陆续收录，请稍后再来。'), 'empty'));
      append(data);
    } catch (error) {
      feed.removeAttribute('aria-busy');
      feed.replaceChildren(failed(error, first));
    }
  }
  more.onclick = async () => {
    more.disabled = true;
    more.textContent = t('正在加载…');
    try { append(await request({})); more.textContent = t('加载更多'); }
    catch { more.textContent = t('加载失败，点击重试'); }
    finally { more.disabled = false; }
  };
  await first();
}

async function daily() {
  const head = pageHead(isAi ? t('每日 AI 与硬科技简报') : t('每日金融简报'), t('每天北京时间 08:00 汇总上一更新窗口；暂无精选时提供明确标注的来源索引。'));
  api('/api/sources').then(data => domainSwitch(head, data.domains)).catch(() => {});
  const requested = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : '';
  const form = el('form', undefined, 'report-picker'), input = el('input'), button = el('button', t('查看日报'), 'btn btn-secondary btn-sm');
  input.type = 'date';
  input.max = today();
  input.value = requested || today();
  input.setAttribute('aria-label', t('日报日期'));
  form.append(input, button);
  form.onsubmit = event => { event.preventDefault(); if (input.value) location.href = inDomain('/daily?date=' + input.value); };
  statusBox.replaceWith(form);
  statusBox = null;

  const layout = el('div', undefined, 'layout'), panel = el('section', undefined, 'panel'), top = el('div', undefined, 'panel-head'), feed = el('div', undefined, 'feed'), foot = el('div', undefined, 'panel-foot');
  const archive = sideCard(t('往期简报')), list = el('ol', undefined, 'archive-list'), side = el('aside', undefined, 'side');
  archive.append(list);
  panel.append(top, feed, foot);
  side.append(archive, toolCard(), sideNote());
  layout.append(panel, side);
  app.append(layout);

  async function load() {
    button.disabled = input.disabled = true;
    feed.setAttribute('aria-busy', 'true');
    top.replaceChildren(el('h2', t('正在加载每日简报…')));
    feed.replaceChildren(...skeleton(6));
    foot.replaceChildren();
    try {
      const data = await reports(), date = requested || data.reports[0]?.date || today();
      input.value = date;
      list.replaceChildren(...data.reports.slice(0, 14).map(r => {
        const li = el('li'), a = link('', inDomain('/daily?date=' + r.date), r.date === date ? 'active' : '');
        a.append(el('span', longDay(r.date)), el('small', r.mode === 'source-index' ? t('来源索引 {count} 条', { count: r.count }) : t('精选 {count} 条', { count: r.count })));
        li.append(a);
        return li;
      }));
      if (!data.reports.length) list.append(el('li', t('暂无往期简报。'), 'hint'));
      if (!requested && !data.reports.length) {
        top.replaceChildren(el('h2', t('暂无简报')));
        feed.replaceChildren(el('p', t('第一份日报将在下一个北京时间 08:00 生成。你可以先查看今日动态。'), 'empty'));
        foot.append(link(t('浏览最近动态 →'), inDomain('/all'), 'text-link'));
        return;
      }
      top.replaceChildren(el('h2', t('正在读取 {date} 的简报…', { date })));
      const report = await api(scoped('/api/reports/' + date)), summary = el('div', undefined, 'report-summary');
      summary.append(el('h2', longDay(date)));
      if (report.items.length) summary.append(el('span', report.mode === 'source-index' ? t('本期收录 {count} 条资讯 · 来源索引', { count: report.items.length }) : t('本期精选 {count} 条资讯', { count: report.items.length }), 'hint'));
      top.replaceChildren(summary);
      if (report.windowStart && report.windowEnd) top.append(el('p', t('收录窗口：{start}—{end}（北京时间）', { start: stamp(report.windowStart), end: stamp(report.windowEnd) })));
      feed.replaceChildren(...report.items.map(item => row(report.mode === 'source-index' ? item : { ...item, selected: 0 }, { full: true })));
      if (report.mode === 'source-index' && report.items.length) feed.prepend(el('p', t('本期没有入选精选，以下提供普通摘要和原文入口，供你继续阅读。'), 'notice'));
      if (!report.items.length) feed.append(el('p', t('本期窗口内暂未收录可展示的资讯，请浏览今日动态或选择其他日期。'), 'empty'));
      foot.append(link(t('浏览最近动态 →'), inDomain('/all'), 'text-link'));
      if (hybrid && report.items.length) foot.append(link(t('本期归档页 →'), inDomain('/daily/' + date), 'text-link'));
    } catch (error) {
      top.replaceChildren(el('h2', t('简报加载失败')));
      feed.replaceChildren(failed(error, load));
      foot.append(link(t('浏览最近动态 →'), inDomain('/all'), 'text-link'));
    } finally {
      button.disabled = input.disabled = false;
      feed.removeAttribute('aria-busy');
    }
  }
  await load();
}

async function about() {
  pageHead(t('关于 FinHot'), t('FinHot 是一个独立维护的金融信息产品，面向市场观察者、投资研究者，以及希望理解金融世界的人。'));
  const column = el('div', undefined, 'stack layout-single'), intro = el('section', undefined, 'panel panel-body'), products = el('div', undefined, 'product-cards');
  intro.append(el('p', t('市场消息、公司披露和研究观点，往往分散在不同平台。我们希望把发现信息、读懂要点、回到原文这几步，做得更顺手。'), 'lead'));
  for (const [name, description, url] of [[t('FinHot 金融资讯'), t('发现市场、公司与研究动态，按来源检索，阅读每日简报。'), '/all'], [t('FinMap 金融图谱'), t('查询金融机构，探索机构及其股权关系。'), 'https://map.finhot.fun/']]) {
    const card = url.startsWith('https:') ? external('', url, 'product-card') : link('', url, 'product-card');
    card.append(el('h2', name + ' ↗'), el('p', description));
    products.append(card);
  }
  intro.append(products);
  const principles = el('section', undefined, 'panel panel-body prose');
  principles.append(
    el('h2', t('我们的信息原则')), el('p', t('来源可追溯：保留发布机构、来源时间与原文入口。摘要有边界：只依据实际取得的材料整理，PDF 片段会注明范围。判断属于读者：资讯与研究观点不构成投资建议。')),
    el('h2', t('收录范围与更新')), el('p', t('覆盖公开市场资讯、上市公司公告、公司与行业研报，以及政策和宏观数据。公告采用抽样收录，完整披露请以巨潮、交易所等原始平台为准；付费研报与实时行情不在承诺覆盖范围内。')), el('p', t('不同信源按各自频率更新，发布时间与收录时间分别标注。来源故障或处理排队可能带来延迟。尚无摘要时保留原题和原文链接；中文摘要与经过评审的精选摘要分别标注。')),
    el('h2', t('如何使用 FinHot')), el('p', t('在金融动态中按栏目、信源或关键词查找信息；搜索覆盖近期收录的标题、原题和摘要，最多 5,000 条，不含原文全文。每日简报在北京时间 08:00 汇总上一更新窗口，有精选时展示精选，暂无精选时提供来源索引。')), el('p', t('已经公开的独立文章和日报保留归档地址，实际撤回或下架的内容会移除。你也可以通过 RSS 在自己的阅读器中订阅精选。')),
    el('h2', t('交流与合作')), el('p', t('FinHot 由维护者独立运营。欢迎产品建议、信源推荐与合作交流。')), link('hello@finhot.fun ↗', 'mailto:hello@finhot.fun'), el('p', t('内容更正、来源展示调整或删除请求，也可以通过站内反馈提交。')), link(t('提交反馈 →'), '/feedback'),
  );
  const sources = el('section', undefined, 'panel panel-body');
  sources.id = 'sources';
  sources.append(el('h2', t('公开信源')), el('p', t('以下是收录入口，展示不代表与来源机构存在合作或背书关系。'), 'hint'));
  column.append(intro, principles, sources);
  app.append(column);
  try {
    const data = await api('/api/sources');
    sources.querySelector('.hint').textContent += ' ' + t('当前接入 {count} 个公开信源入口；同一家机构可能有多个栏目。', { count: data.sources.length });
    // With more than one domain, AI & deep tech sources are listed on their own, then finance's columns.
    const multi = (data.domains || []).length > 1, financeOnly = s => !multi || !s.domains || s.domains.includes('finance');
    const sections = [...(multi ? (data.domains || []).filter(d => d.key !== 'finance').map(d => [d.label, s => s.domains?.includes(d.key) && !s.domains.includes('finance')]) : []),
      ...Object.entries(data.groups || {}).map(([key, label]) => [(multi ? t('金融') + ' · ' : '') + (groups[key] || label), s => s.group === key && financeOnly(s)])];
    for (const [heading, belongs] of sections) {
      const items = data.sources.filter(belongs);
      if (!items.length) continue;
      const box = el('div', undefined, 'source-group');
      box.append(el('h3', heading));
      for (const s of items) {
        const line = el('div', undefined, 'source-row'), info = el('span'), late = s.failed ? el('span', t('更新暂有延迟'), 'is-late') : el('span', t('源内最新 {time}', { time: valid(s.latest_published_at) ? stamp(s.latest_published_at) : t('待核实') }));
        info.append(late, link(t('浏览收录 →'), '/all?source=' + encodeURIComponent(s.id)));
        line.append(safeUrl(s.homepage) ? external(s.name + ' ↗', s.homepage) : el('span', s.name), info);
        box.append(line);
      }
      sources.append(box);
    }
  } catch { sources.append(el('p', t('信源目录暂时无法加载，请稍后重试。'), 'hint')); }
}

async function policy(name) {
  pageHead(name === 'terms' ? t('使用说明') : t('隐私说明'), t('维护署名：FinHot 维护者 · 联系渠道：站内反馈'));
  const panel = el('section', undefined, 'panel panel-body prose layout-single');
  app.append(panel);
  const response = await fetch(`/${name}${en ? '.en' : ''}.txt`);
  if (!response.ok) throw new Error(t('说明加载失败'));
  const text = await response.text(), body = el('div');
  body.lang = language;
  for (const block of text.trim().split(/\n\s*\n/)) { if (block.startsWith('# ')) continue; body.append(block.startsWith('## ') ? el('h2', block.slice(3)) : el('p', block)); }
  panel.append(body, link(t('反馈与更正') + ' →', '/feedback', 'more'));
}

function feedback() {
  pageHead(t('反馈与更正'), t('链接失效、摘要有误或来源展示问题，都可以在这里告诉维护者。'));
  const panel = el('section', undefined, 'panel form-panel'), form = el('form', undefined, 'panel-body form-stack');
  const label = el('label', t('问题说明 *'), 'field'), message = el('textarea');
  message.rows = 7;
  message.required = true;
  message.minLength = 10;
  message.maxLength = 1500;
  message.placeholder = t('请附上文章链接、问题说明和可供核对的依据。');
  label.append(message);
  const contactLabel = el('label', t('联系方式（选填）'), 'field'), contact = el('input');
  contact.type = 'text';
  contact.maxLength = 150;
  contact.placeholder = t('邮箱或其他方便联系的方式');
  contactLabel.append(contact);
  const trap = el('input', undefined, 'trap');
  trap.name = 'website';
  trap.tabIndex = -1;
  trap.autocomplete = 'off';
  trap.setAttribute('aria-hidden', 'true');
  const actions = el('div', undefined, 'form-actions'), submit = el('button', t('提交反馈'), 'btn btn-primary'), state = el('p', '', 'hint');
  state.setAttribute('role', 'status');
  actions.append(submit, state);
  form.append(label, contactLabel, trap, el('p', t('反馈只供维护者处理，保存 30 天。请勿提交密码、证件号码或无关个人信息。'), 'hint'), actions);
  form.onsubmit = async event => {
    event.preventDefault();
    submit.disabled = true;
    state.className = 'hint';
    state.textContent = '';
    try {
      const result = await api('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: message.value, contact: contact.value, website: trap.value }) });
      state.textContent = t('已收到，谢谢。反馈编号：{id}', { id: result.id || t('已受理') });
      state.className = 'success';
      form.reset();
    } catch (error) { state.textContent = failure(error); state.className = 'error'; }
    finally { submit.disabled = false; }
  };
  panel.append(form);
  app.append(panel);
}

function admin() {
  pageHead(t('站点运行状态'), t('管理员可查看采集情况、模型用量和读者反馈。'));
  const panel = el('section', undefined, 'panel'), form = el('form', undefined, 'panel-body form-stack'), label = el('label', t('管理员密码'), 'field'), password = el('input');
  password.type = 'password';
  password.required = true;
  password.autocomplete = 'current-password';
  label.append(password);
  const actions = el('div', undefined, 'form-actions'), submit = el('button', t('查看状态'), 'btn btn-primary'), output = el('pre', t('登录后显示运行状态'), 'output');
  actions.append(submit);
  form.append(label, actions, output);
  form.onsubmit = async event => {
    event.preventDefault();
    submit.disabled = true;
    try { output.textContent = JSON.stringify(await api('/api/admin/status', { headers: { authorization: `Bearer ${password.value}` } }), null, 2); }
    catch (error) { output.textContent = failure(error); }
    finally { submit.disabled = false; }
  };
  panel.classList.add('form-panel');
  panel.append(form);
  app.append(panel);
}

function missing() {
  pageHead(t('这个页面不存在'), t('可以返回首页，继续浏览最新资讯。'));
  app.append(link(t('返回首页 →'), '/', 'btn btn-secondary'));
}

const titles = { '/all': isAi ? t('AI 与硬科技动态') : t('金融动态'), '/daily': isAi ? t('每日 AI 与硬科技简报') : t('每日金融简报'), '/about': t('关于 FinHot'), '/feedback': t('反馈与更正'), '/terms': t('使用说明'), '/privacy': t('隐私说明'), '/admin': t('管理员入口') };
const routes = { '/': home, '/all': explore, '/daily': daily, '/about': about, '/terms': () => policy('terms'), '/privacy': () => policy('privacy'), '/feedback': feedback, '/admin': admin };
const navPath = path.startsWith('/daily') ? '/daily' : path;
document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === navPath));
// Older homepage links carried explorer filters; keep them working.
if (path === '/' && ['view', 'q', 'category', 'source', 'group'].some(key => params.has(key))) location.replace('/all' + location.search);
else {
  document.title = path === '/' ? (isAi ? t('FinHot · 最新 AI 与硬科技资讯与每日简报') : t('FinHot · 最新金融资讯与每日简报')) : (titles[path] || t('这个页面不存在')) + ' · FinHot';
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) canonical.href = 'https://finhot.fun' + (path === '/' ? '/' : path) + (params.get('domain') === 'ai' && ['/', '/all', '/daily'].includes(path) ? '?domain=ai' : '');
  app.replaceChildren();
  try { await (routes[path] || missing)(); } catch (error) { app.append(el('p', failure(error), 'empty error')); }
  if (hybrid && path === '/all') { setInterval(refreshHealth, 300000); document.addEventListener('visibilitychange', refreshHealth); }
}
