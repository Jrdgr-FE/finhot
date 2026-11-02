// Shared product frame also mounts on the existing server-rendered article pages.
// Content, data requests and publication behavior remain in their original modules.
import './fin-suite.js';

const icons = {
  inbox: '<path d="M4 4h16v16H4zM4 14h5l2 3h2l2-3h5"/>',
  news: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/>',
  book: '<path d="M5 3h14v18H5zM8 7h8M8 11h8M8 15h5"/>',
  map: '<rect x="9" y="2" width="6" height="6" rx="1"/><path d="M12 8v5M5 16v-3h14v3"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
  message: '<path d="M3 4h18v13H9l-5 4v-4H3zM7 8h10M7 12h7"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  moon: '<path d="M20.5 13.2A9 9 0 0 1 10.8 3.5a9 9 0 1 0 9.7 9.7Z"/>',
};
const icon = (name, className = '') => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const requested = new URLSearchParams(location.search).get('lang');
let stored;
try { stored = localStorage.getItem('finhot-lang'); } catch {}
const en = requested ? requested === 'en' : stored === 'en';
const tr = (zh, english) => en ? english : zh;
const path = location.pathname.replace(/\/$/, '') || '/';
const current = path === '/' ? 'home' : path.startsWith('/daily') ? 'daily' : path === '/about' ? 'about' : path === '/feedback' ? 'feedback' : path.startsWith('/all') || path.startsWith('/articles/') ? 'all' : '';
const entries = [
  ['home', '/', 'inbox', tr('最新', 'Latest')],
  ['all', '/all', 'news', tr('资讯库', 'Archive')],
  ['daily', '/daily', 'book', tr('每日简报', 'Daily brief')],
  ['map', 'https://map.finhot.fun/', 'map', tr('公司研究', 'Research')],
  ['about', '/about', 'info', tr('关于信源', 'Sources')],
];
const header = document.querySelector('.header');
if (header && !document.body.classList.contains('fin-terminal')) {
  document.body.classList.add('fin-terminal');
  const languageButton = header.querySelector('.language-toggle');
  header.classList.add('suite-header');
  header.innerHTML = `<div class="bar">
    <button class="suite-menu-button" type="button" aria-controls="suite-navigation" aria-expanded="false" aria-label="${tr('打开导航', 'Open navigation')}">${icon('menu')}</button>
    <details class="suite-switch">
      <summary aria-label="${tr('切换产品，当前 FinHot', 'Switch product, currently FinHot')}"><img src="/logo.svg" width="25" height="25" alt=""><strong>FinHot</strong>${icon('down')}</summary>
      <div class="suite-products">
        <a class="suite-product-link" href="/" aria-current="true">${icon('news')}<span><strong>FinHot</strong><small>${tr('市场资讯与每日简报', 'Market news & daily briefs')}</small></span><span aria-hidden="true">✓</span></a>
        <a class="suite-product-link" href="https://map.finhot.fun/">${icon('map')}<span><strong>FinMap</strong><small>${tr('公司动态与产业研究', 'Company & industry research')}</small></span><span aria-hidden="true">↗</span></a>
      </div>
    </details>
    <span class="suite-product-context">${tr('金融资讯', 'Financial intelligence')}</span>
    <span class="suite-section">${entries.find(e => e[0] === current)?.[3] || tr('阅读与服务', 'Reader services')}</span>
    <div class="header-actions">
      <form class="suite-global-search" action="/all" role="search">${icon('search')}<input type="search" name="q" maxlength="80" placeholder="${tr('搜索资讯、公司或关键词…', 'Search news, companies…')}" aria-label="${tr('搜索全部资讯', 'Search all news')}">${en ? '<input type="hidden" name="lang" value="en">' : ''}</form>
      <button class="suite-theme-button" data-suite-theme type="button" aria-label="${tr('切换深浅色', 'Switch theme')}">${icon('sun', 'suite-sun')}${icon('moon', 'suite-moon')}</button>
    </div>
  </div>`;
  if (languageButton) header.querySelector('.header-actions').append(languageButton);
  const rail = document.createElement('aside');
  rail.className = 'suite-rail'; rail.id = 'suite-navigation'; rail.setAttribute('aria-label', tr('工作区导航', 'Workspace navigation'));
  rail.innerHTML = `<button class="suite-rail-close" data-suite-menu-close type="button" aria-label="${tr('关闭导航', 'Close navigation')}">${icon('close')}</button><nav aria-label="${tr('主导航', 'Main navigation')}">${entries.map(([key, href, glyph, label]) => `<a class="suite-rail-link" href="${href}" ${key === current ? 'aria-current="page"' : ''} ${['about', 'map'].includes(key) ? 'data-separated' : ''}>${icon(glyph)}<span>${label}</span></a>`).join('')}</nav><a class="suite-rail-link suite-rail-bottom" href="/feedback" ${current === 'feedback' ? 'aria-current="page"' : ''}>${icon('message')}<span>${tr('反馈', 'Feedback')}</span></a>`;
  header.after(rail);
  const scrim = document.createElement('button');
  scrim.className = 'suite-scrim'; scrim.hidden = true; scrim.setAttribute('aria-label', tr('关闭导航遮罩', 'Close navigation overlay')); scrim.dataset.suiteMenuClose = '';
  rail.after(scrim);
  const menu = header.querySelector('.suite-menu-button');
  const layers = [header, document.querySelector('main'), document.querySelector('footer')].filter(Boolean);
  const setMenu = open => {
    document.body.classList.toggle('suite-menu-open', open);
    menu.setAttribute('aria-expanded', String(open)); scrim.hidden = !open;
    layers.forEach(layer => { layer.inert = open; });
    if (open) rail.querySelector('button').focus();
    else if (menu.getClientRects().length) menu.focus();
  };
  menu.addEventListener('click', () => setMenu(true));
  document.querySelectorAll('[data-suite-menu-close]').forEach(b => b.addEventListener('click', () => setMenu(false)));
  matchMedia('(min-width: 1001px)').addEventListener('change', e => { if (e.matches && document.body.classList.contains('suite-menu-open')) setMenu(false); });
  document.addEventListener('keydown', event => {
    if (!document.body.classList.contains('suite-menu-open')) return;
    if (event.key === 'Escape') setMenu(false);
    if (event.key === 'Tab') {
      const items = [...rail.querySelectorAll('a,button')].filter(e => e.getClientRects().length), first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  document.querySelectorAll('[data-i18n="FinMap 金融图谱 ↗"]').forEach(a => { a.dataset.i18n = 'FinMap 公司研究 ↗'; a.textContent = tr('FinMap 公司研究 ↗', 'FinMap company research ↗'); });
  const favicon = document.createElement('link'); favicon.rel = 'icon'; favicon.type = 'image/svg+xml'; favicon.href = '/logo.svg'; document.head.append(favicon);
  window.FinSuite.refresh();
}
