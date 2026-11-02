/* Fin product family · v1. No analytics, network requests or account data. */
(() => {
  if (window.FinSuite) return;
  const valid = value => value === 'light' || value === 'dark';
  const store = 'fin-suite-theme';
  const readCookie = () => document.cookie.split(';').map(v => v.trim()).find(v => v.startsWith(store + '='))?.slice(store.length + 1);
  const system = matchMedia('(prefers-color-scheme: dark)');
  const preferred = () => {
    const cookie = readCookie();
    if (valid(cookie)) return cookie;
    try {
      const local = localStorage.getItem(store) || localStorage.getItem('finmap-theme');
      if (valid(local)) return local;
    } catch { /* Functional UI still works when storage is blocked. */ }
    return null;
  };
  const apply = theme => {
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-suite-theme]').forEach(button => {
      button.setAttribute('aria-pressed', String(theme === 'dark'));
      button.setAttribute('aria-label', document.documentElement.lang.startsWith('en') ? (theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode') : (theme === 'dark' ? '切换为浅色模式' : '切换为深色模式'));
    });
  };
  const choose = theme => {
    if (!valid(theme)) return;
    try { localStorage.setItem(store, theme); } catch {}
    // A functional appearance preference is shared only by these sibling sites.
    if (location.protocol === 'https:' && (location.hostname === 'finhot.fun' || location.hostname.endsWith('.finhot.fun'))) {
      document.cookie = `${store}=${theme}; Domain=finhot.fun; Path=/; Max-Age=31536000; Secure; SameSite=Lax`;
    }
    apply(theme);
  };
  const refresh = () => apply(preferred() || (system.matches ? 'dark' : 'light'));
  window.FinSuite = { refresh, choose };
  refresh();
  document.addEventListener('DOMContentLoaded', refresh, { once: true });
  window.addEventListener('pageshow', refresh);
  window.addEventListener('focus', refresh);
  window.addEventListener('storage', event => { if (event.key === store) refresh(); });
  system.addEventListener('change', refresh);
  document.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('[data-suite-theme]')) choose(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    document.querySelectorAll('.suite-switch[open]').forEach(menu => {
      if (!menu.contains(event.target) || event.target.closest('a')) menu.open = false;
    });
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const menu = document.querySelector('.suite-switch[open]');
    if (menu) { event.preventDefault(); event.stopImmediatePropagation(); menu.open = false; menu.querySelector('summary')?.focus(); }
  });
})();
