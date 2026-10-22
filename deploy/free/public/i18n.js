import { messages } from './translations.js';

// Chinese is the default. Only an explicit toggle is remembered: the previous
// key ('finhot-language') was written on every visit while English was the
// default, so it says nothing about what a reader actually chose.
const key = 'finhot-lang';
const read = () => { try { return localStorage.getItem(key); } catch { return null; } };
const write = value => { try { localStorage.setItem(key, value); localStorage.removeItem('finhot-language'); } catch { /* Storage can be disabled. */ } };
const requested = new URLSearchParams(location.search).get('lang');
const preferred = read() === 'en' ? 'en' : 'zh-CN';
export const language = requested === 'en' ? 'en' : requested === 'zh-CN' || requested === 'zh' ? 'zh-CN' : preferred;
export const locale = language === 'en' ? 'en-GB' : 'zh-CN';
export const t = (text, values = {}) => {
  const translated = language === 'en' ? messages[text] ?? text : text;
  return translated.replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
};

// Server-rendered pages choose their content language from ?lang= and mark it
// with data-content-language; reload when it differs from the reader's choice.
const content = document.querySelector('[data-content-language]');
if (content ? content.dataset.contentLanguage !== language : language === 'en' && !requested && /^\/(?:articles\/|daily\/.)/.test(location.pathname)) {
  const url = new URL(location.href);
  url.searchParams.set('lang', language);
  location.replace(url.href);
}

// Only annotated interface copy is translated. Source titles and summaries are untouched.
document.documentElement.lang = language;
for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
for (const attribute of ['aria-label', 'content', 'title']) {
  for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
    element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
  }
}
for (const button of document.querySelectorAll('.language-toggle')) {
  button.hidden = false;
  button.textContent = language === 'en' ? '中文' : 'EN';
  button.lang = language === 'en' ? 'zh-CN' : 'en';
  button.setAttribute('aria-label', language === 'en' ? 'Switch to Chinese' : '切换为英文');
  button.addEventListener('click', () => {
    const next = language === 'en' ? 'zh-CN' : 'en';
    write(next);
    const url = new URL(location.href);
    if (next === 'en') url.searchParams.set('lang', 'en');
    else url.searchParams.delete('lang');
    location.assign(url.href);
  });
}
// Carry a non-default language across internal links, even without storage.
document.addEventListener('click', event => {
  if (language === 'zh-CN' && preferred === 'zh-CN') return;
  const anchor = event.target.closest?.('a[href]');
  if (!anchor || anchor.hasAttribute('download')) return;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin || url.searchParams.has('lang') || !/^\/(?:$|all\/?$|daily(?:\/|$)|articles\/|about\/?$|feedback\/?$|terms\/?$|privacy\/?$|admin\/?$)/.test(url.pathname)) return;
  url.searchParams.set('lang', language);
  anchor.href = url.href;
});
