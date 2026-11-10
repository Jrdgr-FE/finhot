// FinHot front end. One module renders every static route; the server renders
// /articles/* and /daily/<date> itself and only loads style.css and i18n.js.
import { t, locale, language } from './i18n.js';
import { syncTerminalFrame } from './terminal.js';

const app = document.querySelector('#app');
const hybrid = document.querySelector('meta[name="finhot-edition"]')?.content === 'hybrid';
const en = language === 'en';
const zone = 'Asia/Shanghai';
const groups = { market: t('市场动态'), company: t('上市公司'), research: t('投资研究'), macro: t('政策与宏观'), global: t('海外金融') };
const categories = {
  policy: t('政策监管'), macro: t('宏观数据'), market: t('市场行情'), earnings: t('财报业绩'), corporate: t('公司事件'), research: t('投资研究'),
  banking: t('银行'), securities: t('证券'), insurance: t('保险'), fund: t('资管'), institution: t('机构动态'),
  'ai-models': t('模型'), 'ai-products': t('产品与工具'), chips: t('芯片与半导体'), compute: t('算力与数据中心'), robotics: t('机器人'),
  'ai-research': t('论文研究'), 'ai-policy': t('政策与安全'), 'ai-opinion': t('观点与实践'), 'ai-business': t('产业与资本'),
};

// Domains: AI & deep tech and finance. A link's ?domain= wins, then the reader's last explicit switch,
// then finance. Finance links carry no parameter, so its pages and old links stay as they were.
const domainCategories = {
  finance: ['policy', 'macro', 'market', 'earnings', 'corporate', 'research', 'banking', 'securities', 'insurance', 'fund', 'institution'],
  ai: ['ai-models', 'ai-products', 'chips', 'compute', 'robotics', 'ai-research', 'ai-policy', 'ai-opinion', 'ai-business'],
};
const domainNames = { ai: t('AI 与硬科技'), finance: t('金融') };
const defaultDomains = [
  { key: 'ai', label: 'AI 与硬科技', labelEn: 'AI & Deep Tech' },
  { key: 'finance', label: '金融', labelEn: 'Finance' },
];
const domainStore = 'finhot-domain';
const storedDomain = () => { try { return localStorage.getItem(domainStore); } catch { return null; } };
const rememberDomain = value => { try { localStorage.setItem(domainStore, value); } catch { /* Storage can be disabled. */ } };

let path = location.pathname.replace(/\/$/, '') || '/';
let params = new URLSearchParams(location.search);
let domain = [params.get('domain'), storedDomain()].find(value => Object.hasOwn(domainNames, value)) || 'finance';
let isAi = domain === 'ai';

function syncLocation() {
  path = location.pathname.replace(/\/$/, '') || '/';
  params = new URLSearchParams(location.search);
  if (params.get('domain') && Object.hasOwn(domainNames, params.get('domain'))) {
    rememberDomain(params.get('domain'));
  }
  domain = [params.get('domain'), storedDomain()].find(value => Object.hasOwn(domainNames, value)) || 'finance';
  isAi = domain === 'ai';
}

/** A site link in the current domain. */
const inDomain = href => { if (domain === 'finance') return href; const u = new URL(href, location.origin); u.searchParams.set('domain', domain); return u.pathname + u.search + u.hash; };
/** An API request in the current domain. */
const scoped = href => { const u = new URL(href, location.origin); u.searchParams.set('domain', domain); return u.pathname + u.search; };

const el = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
const link = (text, href, className) => { const a = el('a', text, className); a.href = href; return a; };
const external = (text, href, className) => { const a = link(text, href, className); a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
const han = value => /[\u3400-\u9fff]/u.test(value || '');
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
  if (response.status === 400 && data.error === '无效领域' && domain !== 'finance') { rememberDomain('finance'); const u = new URL(location.href); u.searchParams.delete('domain'); navigate(u.pathname + u.search, { replace: true }); }
  if (!response.ok) throw new Error(en && han(data.error) ? t('加载失败，请稍后重试') : data.error || t('加载失败，请稍后重试'));
  return data;
}
const failure = error => error?.name === 'TimeoutError' || error?.name === 'AbortError' ? t('加载超时，请稍后重试。') : error instanceof TypeError ? t('网络连接失败，请稍后重试。') : error?.message || t('加载失败，请稍后重试');

const reportListCache = new Map();
const reports = () => {
  const d = domain;
  if (!reportListCache.has(d)) {
    reportListCache.set(d, api(scoped('/api/reports')).catch(error => { reportListCache.delete(d); throw error; }));
  }
  return reportListCache.get(d);
};
let sourcesCatalogPromise = null;
const getSourcesCatalog = () => (sourcesCatalogPromise ||= api('/api/sources').catch(error => { sourcesCatalogPromise = null; throw error; }));

// English readers get the translated headline and summary when the backend has one.
const localize = item => en ? { ...item, title: item.title_en || (!han(item.original_title) && item.original_title) || item.title, summary: item.summary_en || item.summary } : item;
const articleHref = item => hybrid ? '/articles/' + encodeURIComponent(item.id) + (en ? '?lang=en' : '') : safeUrl(item.url) || '#';

function displayCategory(item) {
  if (item.category && domainCategories[domain]?.includes(item.category)) return item.category;
  const text = `${item.title || ''} ${item.original_title || ''} ${item.summary || ''}`;
  if (isAi) {
    if (/芯片|半导体|晶圆|制程|光刻|封装|载板|HBM|GPU|TPU|NPU|加速卡|DRAM|NAND|EDA|\bchips?\b|semiconductor|wafer|foundry/i.test(text)) return 'chips';
    if (/数据中心|智算|算力|超算|服务器|液冷|云算力|data ?cent(?:er|re)|supercomputer/i.test(text)) return 'compute';
    if (/机器人|具身|人形|自动驾驶|智驾|灵巧手|无人机|eVTOL|robot|humanoid|autonomous/i.test(text)) return 'robotics';
    if (/大模型|模型|权重|GPT|Claude|Gemini|Llama|Qwen|DeepSeek|Kimi|\bmodel\b|weights/i.test(text)) return 'ai-models';
    if (/智能体|Agent|应用|API|工具|Copilot|插件/i.test(text)) return 'ai-products';
    if (/论文|arXiv|基准|数据集|技术报告|METR|CoRL|NeurIPS|\bpaper\b|benchmark|dataset/i.test(text)) return 'ai-research';
    if (/出口管制|实体清单|禁令|监管|立法|法案|安全|进网|工信部|export control|regulat/i.test(text)) return 'ai-policy';
    return 'ai-business';
  }
  const sid = item.source_id || '';
  if (sid.startsWith('eastmoney-research-')) return 'research';
  if (/财报|年度报告|半年度报告|季度报告|三季报|半年报|年报|业绩预告|业绩快报|营收|净利润/.test(text)) return 'earnings';
  if (['cninfo-company', 'cninfo-financial', '21jingji-company'].includes(sid)) return 'corporate';
  if (['web-csrc-news', 'pbc-news', 'safe-news', 'fed-press', 'ecb-press'].includes(sid)) return 'policy';
  if (['stats-data-release', 'stats-data-interpretation', 'bea-news', 'calculated-risk', 'nyfed-liberty-street'].includes(sid)) return 'macro';
  return 'market';
}

const FINMAP_VENTURES = [
  ['openai', 'OpenAI', /\bOpenAI\b|\bChatGPT\b|\bGPT-[456]\b/i],
  ['anthropic', 'Anthropic', /\bAnthropic\b|\bClaude\b/i],
  ['deepseek', '深度求索', /\bDeepSeek\b|深度求索/i],
  ['moonshot', '月之暗面', /月之暗面|\bMoonshot\b|\bKimi\b/i],
  ['zhipu', '智谱', /智谱|\bZhipu\b|\bChatGLM\b|\bGLM-[45]/i],
  ['minimax', 'MiniMax', /\bMiniMax\b|海螺AI/i],
  ['baichuan', '百川智能', /百川智能/],
  ['stepfun', '阶跃星辰', /阶跃星辰|\bStepFun\b/i],
  ['siliconflow', '硅基流动', /硅基流动|\bSiliconFlow\b/i],
  ['huggingface', 'Hugging Face', /\bHugging ?Face\b/i],
  ['mistral', 'Mistral AI', /\bMistral\b|\bVoxtral\b/i],
  ['cohere', 'Cohere', /\bCohere\b/i],
  ['google-deepmind', 'Google DeepMind', /\bDeepMind\b|\bGemini\b/i],
  ['nvidia', '英伟达', /英伟达|\bNVIDIA\b|\bVera Rubin\b/i],
  ['amd', 'AMD', /\bAMD\b|超威半导体/],
  ['cambricon', '寒武纪', /寒武纪/],
  ['moore-threads', '摩尔线程', /摩尔线程/],
  ['metax', '沐曦股份', /沐曦/],
  ['biren', '壁仞科技', /壁仞/],
  ['enflame', '燧原科技', /燧原/],
  ['iluvatar', '天数智芯', /天数智芯/],
  ['kunlunxin', '昆仑芯', /昆仑芯/],
  ['smic', '中芯国际', /中芯国际|\bSMIC\b/],
  ['huahong-semi', '华虹半导体', /华虹半导体|华虹宏力/],
  ['tsmc', '台积电', /台积电|\bTSMC\b/i],
  ['naura', '北方华创', /北方华创/],
  ['amec', '中微公司', /中微公司/],
  ['acm-shanghai', '盛美上海', /盛美上海/],
  ['asml', '阿斯麦', /阿斯麦|\bASML\b/],
  ['jcet', '长电科技', /长电科技/],
  ['empyrean', '华大九天', /华大九天/],
  ['coreweave', 'CoreWeave', /\bCoreWeave\b/i],
  ['cerebras', 'Cerebras', /\bCerebras\b/i],
  ['groq', 'Groq', /\bGroq\b/i],
  ['tenstorrent', 'Tenstorrent', /\bTenstorrent\b/i],
  ['unitree', '宇树科技', /宇树|\bUnitree\b/i],
  ['agibot', '智元机器人', /智元机器人|\bAgiBot\b/i],
  ['galbot', '银河通用', /银河通用/],
  ['fourier', '傅利叶', /傅利叶/],
  ['ubtech', '优必选', /优必选|\bUBTECH\b/i],
  ['deeprobotics', '云深处', /云深处/],
  ['limx', '逐际动力', /逐际动力|\bLimX\b/i],
  ['robotera', '星动纪元', /星动纪元/],
  ['galaxea', '星海图', /星海图/],
  ['spirit-ai', '千寻智能', /千寻智能/],
  ['x-square', '自变量机器人', /自变量机器人/],
  ['lightwheel', '光轮智能', /光轮智能/],
  ['linkerbot', '灵心巧手', /灵心巧手/],
  ['inspire-robots', '因时机器人', /因时机器人/],
  ['paxini', '帕西尼感知', /帕西尼/],
  ['leaderdrive', '绿的谐波', /绿的谐波/],
  ['hesai', '禾赛科技', /禾赛/],
  ['robosense', '速腾聚创', /速腾聚创/],
  ['orbbec', '奥比中光', /奥比中光/],
  ['inovance', '汇川技术', /汇川技术/],
  ['figure', 'Figure AI', /\bFigure AI\b|\bFigure 0[123]\b/i],
  ['physical-intelligence', 'Physical Intelligence', /\bPhysical Intelligence\b/i],
  ['dji', '大疆创新', /大疆|\bDJI\b/],
  ['insta360', '影石创新', /影石|\bInsta360\b/i],
  ['bambu-lab', '拓竹科技', /拓竹|\bBambu Lab\b/i],
  ['rokid', 'Rokid', /\bRokid\b|乐奇/i],
  ['xreal', 'XREAL', /\bXREAL\b/i],
  ['pony-ai', '小马智行', /小马智行|\bPony\.ai\b/i],
  ['weride', '文远知行', /文远知行|\bWeRide\b/i],
  ['momenta', 'Momenta', /\bMomenta\b/i],
  ['deeproute', '元戎启行', /元戎启行/],
  ['waymo', 'Waymo', /\bWaymo\b/i],
  ['wayve', 'Wayve', /\bWayve\b/i],
  ['ehang', '亿航智能', /亿航/],
  ['autoflight', '峰飞航空', /峰飞航空/],
  ['aeroht', '小鹏汇天', /小鹏汇天/],
  ['catl', '宁德时代', /宁德时代|\bCATL\b/],
  ['sungrow', '阳光电源', /阳光电源/],
  ['longi', '隆基绿能', /隆基绿能/],
  ['origin-quantum', '本源量子', /本源量子/],
  ['quantumctek', '国盾量子', /国盾量子/],
  ['brainco', '强脑科技', /强脑科技|\bBrainCo\b/i],
  ['landspace', '蓝箭航天', /蓝箭航天/],
  ['galactic-energy', '星河动力', /星河动力/],
  ['cas-space', '中科宇航', /中科宇航/],
  ['space-pioneer', '天兵科技', /天兵科技/],
  ['spacex', 'SpaceX', /\bSpaceX\b/i],
  ['rocket-lab', 'Rocket Lab', /\bRocket Lab\b/i],
  ['world-labs', 'World Labs', /\bWorld Labs\b/i],
  ['runway', 'Runway', /\bRunway\b/i],
];

function matchVentures(item) {
  const text = `${item.title || ''} ${item.original_title || ''}`;
  const out = [];
  for (const [id, name, re] of FINMAP_VENTURES) {
    if (re.test(text)) {
      out.push({ id, name });
      if (out.length >= 2) break;
    }
  }
  return out;
}

let drawerScrim = null;
let drawerPanel = null;

function closeArticleDrawer() {
  if (!drawerPanel) return;
  drawerPanel.hidden = true;
  if (drawerScrim) drawerScrim.hidden = true;
  document.body.classList.remove('drawer-open');
}

function openArticleDrawer(raw, clusterRoot = raw) {
  const item = localize(raw);
  if (!drawerPanel) {
    drawerScrim = el('button', undefined, 'article-drawer-scrim');
    drawerScrim.type = 'button';
    drawerScrim.setAttribute('aria-label', t('关闭阅读面板'));
    drawerScrim.onclick = closeArticleDrawer;
    drawerPanel = el('aside', undefined, 'article-drawer');
    drawerPanel.setAttribute('role', 'dialog');
    drawerPanel.setAttribute('aria-modal', 'true');
    drawerPanel.setAttribute('aria-label', t('资讯详情'));
    document.body.append(drawerScrim, drawerPanel);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && drawerPanel && !drawerPanel.hidden) closeArticleDrawer();
    });
  }
  const catKey = displayCategory(item);
  const catLabel = categories[catKey] || t('资讯');
  const domLabel = domainNames[domain] || t('资讯');
  const when = valid(item.published_at) ? item.published_at : valid(item.discovered_at) ? item.discovered_at : null;
  const pageUrl = articleHref(item);
  const outUrl = safeUrl(item.url);

  const topBar = el('div', undefined, 'article-drawer-top');
  const crumb = el('span', `${domLabel} · ${catLabel}`, 'article-drawer-crumb');
  const topActions = el('div', undefined, 'article-drawer-top-actions');
  if (hybrid && pageUrl.startsWith('/articles/')) {
    const standalone = link(t('独立页 ↗'), pageUrl, 'text-link');
    standalone.target = '_blank';
    standalone.rel = 'noopener noreferrer';
    topActions.append(standalone);
  }
  const closeBtn = el('button', '✕', 'article-drawer-close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', t('关闭'));
  closeBtn.onclick = closeArticleDrawer;
  topActions.append(closeBtn);
  topBar.append(crumb, topActions);

  const content = el('div', undefined, 'article-drawer-body');
  const h2 = el('h2', item.title, 'article-drawer-title');
  content.append(h2);

  const meta = el('div', undefined, 'article-drawer-meta');
  if (item.selected) meta.append(el('span', t('精选'), 'badge badge-accent'));
  const srcLink = link(item.source_name, inDomain('/all?source=' + encodeURIComponent(item.source_id || '')), 'row-source');
  srcLink.onclick = () => closeArticleDrawer();
  meta.append(srcLink);
  if (when) meta.append(el('time', (item.published_at ? '' : t('收录于 ')) + stamp(when) + t('（北京时间）')));
  content.append(meta);

  const summaryBox = el('div', undefined, 'article-drawer-summary');
  if (item.summary) {
    for (const para of item.summary.split(/\n+/).filter(Boolean)) {
      summaryBox.append(el('p', para));
    }
  } else {
    summaryBox.append(el('p', t('这条快讯为信源原题索引，暂未生成扩展摘要，请直接点击下方按钮阅读来源原文。'), 'hint'));
  }
  if (item.original_title && item.original_title !== item.title) {
    summaryBox.append(el('p', t('信源原题：') + item.original_title, 'article-drawer-orig'));
  }
  if (item.material_scope) {
    summaryBox.append(el('p', t('材料范围：') + item.material_scope, 'article-drawer-orig'));
  }
  content.append(summaryBox);

  const clusterMembers = clusterRoot?.related_items?.length ? [clusterRoot, ...clusterRoot.related_items] : [];
  if (clusterMembers.length > 1) {
    const relBox = el('div', undefined, 'article-drawer-related');
    relBox.append(el('div', t('同题多源交叉印证（共 {count} 家信源）', { count: clusterMembers.length }), 'article-drawer-related-title'));
    const relList = el('div', undefined, 'article-drawer-related-list');
    for (const member of clusterMembers) {
      const locMember = localize(member);
      const isCurrent = member.id === raw.id;
      const btn = el('button', undefined, 'article-drawer-related-item' + (isCurrent ? ' is-active' : ''));
      btn.type = 'button';
      const head = el('div', undefined, 'article-drawer-related-head');
      head.append(el('strong', member.source_name));
      if (isCurrent) head.append(el('span', t('当前查看'), 'badge badge-accent'));
      const sub = el('span', locMember.title, 'article-drawer-related-headline');
      btn.append(head, sub);
      btn.onclick = () => {
        if (!isCurrent) openArticleDrawer(member, clusterRoot);
      };
      relList.append(btn);
    }
    relBox.append(relList);
    content.append(relBox);
  }

  const ventures = matchVentures(item);
  if (ventures.length) {
    const vBox = el('div', undefined, 'article-drawer-ventures');
    vBox.append(el('div', t('FinMap 关联硬科技公司档案'), 'article-drawer-ventures-title'));
    for (const v of ventures) {
      const card = external('', `https://map.finhot.fun/venture/${encodeURIComponent(v.id)}/`, 'article-drawer-venture-card');
      card.append(
        el('strong', v.name),
        el('span', t('查看融资历程、核心产品与产业链图谱 ↗'))
      );
      vBox.append(card);
    }
    content.append(vBox);
  }

  const actions = el('div', undefined, 'article-drawer-actions');
  if (outUrl) {
    actions.append(external(t('阅读来源原文 ↗'), outUrl, 'btn btn-primary'));
  }
  const copyBtn = el('button', t('复制摘要'), 'btn btn-secondary');
  copyBtn.type = 'button';
  copyBtn.onclick = async () => {
    const shareText = `【${item.title}】\n${item.summary ? item.summary + '\n' : ''}来源：${item.source_name}${outUrl ? '\n原文：' + outUrl : ''}`;
    try {
      await navigator.clipboard.writeText(shareText);
      copyBtn.textContent = t('已复制 ✓');
      setTimeout(() => { copyBtn.textContent = t('复制摘要'); }, 2000);
    } catch { /* ignore */ }
  };
  actions.append(copyBtn);
  content.append(actions);

  const footNote = el('p', t('摘要由模型辅助生成，仅供参考，请以来源原文为准。') + ' ', 'article-drawer-note');
  const fbLink = link(t('反馈与更正 →'), '/feedback');
  fbLink.onclick = () => closeArticleDrawer();
  footNote.append(fbLink);
  content.append(footNote);

  drawerPanel.replaceChildren(topBar, content);
  drawerScrim.hidden = false;
  drawerPanel.hidden = false;
  document.body.classList.add('drawer-open');
}

function row(raw, { full = false } = {}) {
  const item = localize(raw), article = el('article', undefined, 'feed-row' + (item.summary ? '' : ' is-title-only'));
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
  else {
    title.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openArticleDrawer(raw);
    });
  }
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
  meta.append(link(item.source_name, inDomain('/all?source=' + encodeURIComponent(item.source_id || '')), 'row-source'));
  const catKey = displayCategory(item);
  if (categories[catKey]) meta.append(el('span', categories[catKey], 'row-cat'));
  if (!item.summary) meta.append(el('span', t('快讯直达'), 'badge badge-neutral'));
  for (const v of matchVentures(item)) {
    meta.append(external(`${v.name} · 图谱 ↗`, `https://map.finhot.fun/venture/${encodeURIComponent(v.id)}/`, 'badge badge-venture'));
  }
  if (en && item.translation_pending) meta.append(el('span', t('英文译文准备中')));
  const pdf = /^PDF 前 (\d+) 页（共 (\d+) 页）/.exec(item.material_scope || '');
  if (item.summary && pdf) meta.append(el('span', t('摘要基于 PDF 前 {pages}/{total} 页', { pages: pdf[1], total: pdf[2] })));
  const url = safeUrl(item.url);
  if (url && hybrid) meta.append(external(t('原文 ↗'), url, 'row-out'));
  body.append(meta);
  if (Array.isArray(raw.related_items) && raw.related_items.length > 0) {
    const relBar = el('div', undefined, 'row-related');
    relBar.append(el('span', t('同题多源 ({count})', { count: raw.related_items.length }), 'row-related-label'));
    for (const rel of raw.related_items) {
      const locRel = localize(rel);
      const pill = link(rel.source_name, articleHref(rel), 'row-related-pill');
      pill.title = `${rel.source_name}：${locRel.title}`;
      if (!hybrid) {
        pill.target = '_blank';
        pill.rel = 'noopener noreferrer';
      } else {
        pill.addEventListener('click', event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          openArticleDrawer(rel, raw);
        });
      }
      relBar.append(pill);
    }
    body.append(relBar);
  }
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
let lastHealth = null;
/** Render the domain switcher synchronously on domain-scoped pages so the layout never jumps. */
function domainSwitch(head, catalog = defaultDomains) {
  if (!Array.isArray(catalog) || catalog.length < 2) return;
  const existing = head.querySelector('.domain-switch');
  if (existing) existing.remove();
  const nav = el('nav', undefined, 'segmented domain-switch');
  nav.setAttribute('aria-label', t('领域'));
  for (const d of catalog) {
    if (!Object.hasOwn(domainNames, d.key)) continue;
    const u = new URL(location.pathname, location.origin);
    if (path === '/daily' && params.get('date')) u.searchParams.set('date', params.get('date'));
    if (d.key !== 'finance') u.searchParams.set('domain', d.key);
    const a = link(en ? d.labelEn : d.label, u.pathname + u.search, d.key === domain ? 'active' : '');
    if (d.key === domain) a.setAttribute('aria-current', 'page');
    a.addEventListener('click', event => {
      event.preventDefault();
      rememberDomain(d.key);
      navigate(u.pathname + u.search);
    });
    nav.append(a);
  }
  head.prepend(nav);
}
function pageHead(title, description, { withDomainSwitch = false } = {}) {
  const head = el('div', undefined, 'page-head'), copy = el('div');
  copy.append(el('h1', title));
  if (description) copy.append(el('p', description));
  statusBox = el('p', '', 'status');
  statusBox.setAttribute('role', 'status');
  head.append(copy, statusBox);
  if (withDomainSwitch) domainSwitch(head, defaultDomains);
  if (lastHealth) showHealth(lastHealth);
  app.append(head);
  return head;
}
function showHealth(health) {
  if (!health) return;
  lastHealth = health;
  if (!statusBox) return;
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
      for (const raw of report.items.slice(0, 5)) {
        const item = localize(raw), li = el('li'), a = link(item.title, articleHref(item));
        if (hybrid) {
          a.addEventListener('click', event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            openArticleDrawer(raw);
          });
        }
        li.append(a, el('small', item.source_name));
        list.append(li);
      }
      const count = { count: report.items.length }, written = !en && report.review?.themes?.length ? report.review : null;
      body.replaceChildren(el('p', longDay(latest.date) + ' · ' + (written ? t('本期 {count} 条资讯', count) : report.mode === 'source-index' ? t('来源索引 {count} 条', count) : t('精选 {count} 条', count)), 'side-sub'));
      if (written) body.append(el('p', written.headline, 'brief-headline'), el('p', written.overview.length > 90 ? written.overview.slice(0, 90) + '…' : written.overview, 'brief-overview'));
      else if (report.items.length) body.append(list);
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
      const li = el('li'), a = link('', inDomain('/all?source=' + encodeURIComponent(source.id)));
      a.title = source.failed ? t('更新暂有延迟') : valid(source.latest_published_at) ? t('源内最新 {time}', { time: stamp(source.latest_published_at) }) : '';
      a.append(el('span', String(index + 1), 'rank-num'), el('span', source.name, 'rank-name'), el('span', number(source.count), 'rank-count' + (source.failed ? ' is-late' : '')));
      li.append(a);
      return li;
    }));
  };
  return card;
}
function toolCard() {
  const card = sideCard('FinMap ' + t('公司研究'), external(t('工作区 ↗'), 'https://map.finhot.fun/'));
  card.id = 'products';
  card.classList.add('tool-card');
  card.append(el('p', t('追踪 247 家硬科技公司动态与 4,959 家持牌金融机构谱系。')));
  const linksBox = el('div', undefined, 'tool-links');
  linksBox.append(
    external(t('公司动态 →'), 'https://map.finhot.fun/', 'text-link'),
    external(t('硬科技图谱 →'), 'https://map.finhot.fun/ventures/', 'text-link'),
    external(t('公司库 →'), 'https://map.finhot.fun/companies/', 'text-link'),
    external(t('金融谱系 →'), 'https://map.finhot.fun/financial/', 'text-link'),
  );
  card.append(linksBox);
  return card;
}
function sideNote() {
  const note = el('p', t('摘要由模型辅助生成，请核对来源原文；资讯与研究观点不构成投资建议。') + ' ', 'side-note');
  note.append(link(t('了解收录方式'), '/about'));
  return note;
}

const homeFeedCache = new Map();
let cachedCatalogSources = null;

async function home(signal) {
  app.classList.add('page-home');
  const head = pageHead(isAi ? t('最新 AI 与硬科技资讯') : t('最新资讯'), undefined, { withDomainSwitch: true });
  // Finance tabs are source groups; AI tabs are categories ('latest' is the whole domain).
  const tabLabels = isAi ? { latest: t('最新'), 'ai-models': categories['ai-models'], 'ai-products': categories['ai-products'], chips: categories.chips, compute: categories.compute, robotics: categories.robotics, 'ai-business': categories['ai-business'] } : groups;
  const keys = isAi ? ['latest', 'ai-models', 'ai-products', 'chips', 'compute', 'robotics', 'ai-business'] : ['market', 'company', 'research'], first = keys[0];
  const filterOf = key => isAi ? (key === 'latest' ? {} : { category: key }) : { group: key };
  const cacheKey = key => `${domain}:${key}`;
  let active = keys.includes(location.hash.slice(1)) ? location.hash.slice(1) : first, sources = cachedCatalogSources;
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
  if (sources) ranking.update(sources, isAi ? '' : active);
  side.append(briefCard(), ranking, toolCard(), sideNote());
  layout.append(panel, side);
  app.append(layout);

  const matches = item => { const query = search.value.trim().toLowerCase(); return !query || [item.title, item.original_title, item.title_en, item.summary, item.summary_en, item.source_name].join(' ').toLowerCase().includes(query); };
  function links() {
    const query = search.value.trim(), q = new URLSearchParams(filterOf(active));
    if (query) q.set('q', query);
    all.href = inDomain('/all' + (q.size ? '?' + q : ''));
    const label = active === 'latest' ? t('{domain}动态', { domain: domainNames[domain] }) : tabLabels[active];
    // "查看全部 AI 与硬科技动态": a space between Chinese and a Latin-led label.
    const group = !en && /^[A-Za-z]/.test(label) ? ' ' + label : label;
    all.textContent = query ? t('在全部{group}中搜索“{query}” →', { group, query }) : t('查看全部{group} →', { group });
  }
  function render() {
    const entry = homeFeedCache.get(cacheKey(active));
    if (!entry) return;
    const filtered = entry.items.filter(matches);
    const withSum = filtered.filter(i => i.summary && i.summary.trim());
    const items = withSum.length ? withSum : filtered;
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
    if (signal?.aborted) return data;
    if (data.sources) { sources = cachedCatalogSources = data.sources; ranking.update(sources, isAi ? '' : active); }
    showHealth(data.health);
    return data;
  }
  async function load(key, quiet = false) {
    const entry = homeFeedCache.get(cacheKey(key));
    if (entry && Date.now() - entry.at < 300000) return render();
    if (!quiet) { feed.setAttribute('aria-busy', 'true'); feed.replaceChildren(...skeleton()); more.hidden = true; }
    try {
      const data = await page(key, 0);
      if (signal?.aborted) return;
      homeFeedCache.set(cacheKey(key), { items: data.items, hasMore: data.hasMore, nextOffset: data.nextOffset ?? data.items.length, at: Date.now() });
      if (active === key) render();
    } catch (error) {
      if (signal?.aborted || active !== key || quiet) return;
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
  search.addEventListener('keydown', event => { if (event.key === 'Enter' && search.value.trim()) navigate(all.href); });
  more.addEventListener('click', async () => {
    const key = active, entry = homeFeedCache.get(cacheKey(key));
    if (!entry) return;
    more.disabled = true;
    more.textContent = t('正在加载…');
    try {
      const reqOffset = entry.nextOffset ?? entry.items.length;
      const data = await page(key, reqOffset);
      const seen = new Set();
      for (const item of entry.items) {
        seen.add(item.id);
        for (const r of item.related_items || []) seen.add(r.id);
      }
      const fresh = data.items.filter(item => !seen.has(item.id));
      entry.items.push(...fresh);
      entry.nextOffset = data.nextOffset ?? (reqOffset + data.items.length);
      entry.hasMore = data.hasMore && fresh.length > 0;
      if (active === key) { feed.append(...fresh.map(item => row(item))); more.hidden = !entry.hasMore; }
      more.textContent = t('加载更多');
    } catch { more.textContent = t('加载失败，点击重试'); }
    finally { more.disabled = false; }
  });
  // Quietly refresh the first page when a reader comes back to an open tab.
  const refresh = () => {
    const entry = homeFeedCache.get(cacheKey(active));
    if (document.hidden || !entry || Date.now() - entry.at < 300000) return;
    if (search.value.trim() || entry.items.length > 20) return refreshHealth();
    homeFeedCache.delete(cacheKey(active));
    load(active, true);
  };
  document.addEventListener('visibilitychange', refresh, { signal });
  const timer = setInterval(refresh, 300000);
  signal?.addEventListener('abort', () => clearInterval(timer), { once: true });
  select(active);
}

async function explore(signal) {
  const view = ['today', 'selected'].includes(params.get('view')) ? params.get('view') : '';
  // Groups are finance's source columns; a category must belong to the current domain.
  const group = !isAi && groups[params.get('group')] ? params.get('group') : '', source = params.get('source') || '', query = (params.get('q') || '').trim();
  const category = domainCategories[domain].includes(params.get('category')) ? params.get('category') : '';
  const head = pageHead(
    view === 'selected' ? t('精选摘要') : view === 'today' ? (isAi ? t('今日 AI 与硬科技动态') : t('今日金融动态')) : groups[group] || (isAi && categories[category]) || (isAi ? t('AI 与硬科技动态') : t('金融动态')),
    view === 'selected' ? t('通过精选评审的资讯，保留原文与出处。阅读时请留意来源日期。') : isAi ? t('模型、芯片、算力与机器人，一处发现。选择你关心的方向，沿着原文继续探索。') : t('市场、公司与研究，一处发现。选择你关心的方向，沿着原文继续探索。'),
    { withDomainSwitch: true }
  );
  const href = changes => { const q = new URLSearchParams(params); if (domain !== 'finance') q.set('domain', domain); else q.delete('domain'); for (const [key, value] of Object.entries(changes)) value ? q.set(key, value) : q.delete(key); return '/all' + (q.size ? '?' + q : ''); };

  const toolbar = el('div', undefined, 'explore-toolbar'), top = el('div', undefined, 'explore-toolbar-top'), views = el('nav', undefined, 'segmented'), controls = el('div', undefined, 'explore-controls');
  views.setAttribute('aria-label', t('浏览方式'));
  for (const [key, label] of [['', t('全部动态')], ['today', t('今日更新')], ['selected', t('精选摘要')]]) {
    const a = link(label, href({ view: key }), key === view ? 'active' : '');
    if (key === view) a.setAttribute('aria-current', 'page');
    views.append(a);
  }
  const picker = el('select', undefined, 'explore-source-select'), any = el('option', t('全部信源'));
  any.value = '';
  picker.setAttribute('aria-label', t('筛选信源'));
  picker.append(any);
  picker.onchange = () => { navigate(href({ source: picker.value })); };
  const form = el('form', undefined, 'search'), input = el('input'), submit = el('button', t('搜索'), 'btn btn-secondary btn-sm');
  form.setAttribute('role', 'search');
  input.type = 'search';
  input.name = 'q';
  input.maxLength = 80;
  input.value = query;
  input.placeholder = t('搜索公司、标题或摘要');
  input.setAttribute('aria-label', t('搜索公司、标题或摘要'));
  form.append(input, submit);
  form.onsubmit = event => { event.preventDefault(); navigate(href({ q: input.value.trim() })); };
  controls.append(picker, form);
  top.append(views, controls);
  const scopes = el('div', undefined, 'chips'), ownCategories = domainCategories[domain].map(key => [key, categories[key]]);
  if (isAi) {
    for (const [key, label] of [['', t('全部分类')], ...ownCategories]) {
      scopes.append(link(label, href({ category: key }), 'chip' + (key === category ? ' active' : '')));
    }
    toolbar.append(top, scopes);
  } else {
    for (const [key, label] of [['', t('全部栏目')], ...Object.entries(groups)]) {
      scopes.append(link(label, href({ group: key, category: '' }), 'chip' + (key === group && !category ? ' active' : '')));
    }
    for (const [key, label] of ownCategories) {
      scopes.append(link(label, href({ category: key, group: '' }), 'chip' + (key === category ? ' active' : '')));
    }
    toolbar.append(top, scopes);
  }

  const layout = el('div', undefined, 'layout'), main = el('div', undefined, 'stack'), panel = el('section', undefined, 'panel'), feed = el('div', undefined, 'feed'), foot = el('div', undefined, 'panel-foot');
  const more = el('button', t('加载更多'), 'btn btn-secondary btn-sm'), ranking = rankCard(), side = el('aside', undefined, 'side');
  more.type = 'button';
  panel.append(toolbar, feed, foot);
  if (group === 'research') main.append(el('p', t('研报中的预测、评级与观点归属于原研究机构，请结合原文独立判断。'), 'notice'));
  main.append(panel);
  if (cachedCatalogSources) {
    for (const s of cachedCatalogSources.filter(s => (!group || s.group === group) && (!s.domains || s.domains.includes(domain)))) { const option = el('option', s.name); option.value = s.id; picker.append(option); }
    picker.value = source;
    ranking.update(cachedCatalogSources, group);
  }
  side.append(briefCard(), ranking, toolCard(), sideNote());
  layout.append(main, side);
  app.append(layout);
  feed.setAttribute('aria-busy', 'true');
  feed.replaceChildren(...skeleton());

  let range = view === 'today' ? new Date(today() + 'T00:00:00+08:00').toISOString() : '', offset = 0;
  const shown = new Set();
  const request = extra => { const q = new URLSearchParams({ all: view === 'selected' ? '0' : '1', category, group, source, q: query, offset: String(offset), ...extra }); if (range) q.set('from', range); return api(scoped('/api/items?' + q)); };
  function append(data) {
    const rawFresh = data.items.filter(item => !shown.has(item.id));
    const withSum = rawFresh.filter(i => i.summary && i.summary.trim());
    const fresh = withSum.length ? withSum : rawFresh;
    fresh.forEach(item => {
      shown.add(item.id);
      for (const r of item.related_items || []) shown.add(r.id);
    });
    feed.append(...fresh.map(item => row(item)));
    offset = data.nextOffset ?? (offset + data.items.length);
    foot.replaceChildren();
    if (data.hasMore && fresh.length) foot.append(el('span', t('已显示 {count} 条', { count: shown.size }), 'hint'), more);
    else if (shown.size) foot.append(el('span', t('共 {count} 条', { count: shown.size }), 'hint'));
  }
  async function first() {
    feed.setAttribute('aria-busy', 'true');
    try {
      const wantCatalog = !cachedCatalogSources ? { catalog: '1' } : {};
      let data = await request(wantCatalog);
      if (signal?.aborted) return;
      if (view === 'today' && !data.items.length && !category && !group && !source && !query) {
        range = '';
        data = await request(wantCatalog);
        if (signal?.aborted) return;
        main.prepend(el('p', t('今天尚无新收录，以下为最近动态，请留意原文日期。'), 'notice'));
      }
      showHealth(data.health);
      if (!cachedCatalogSources) {
        const catalog = data.sources || (await getSourcesCatalog().catch(() => ({ sources: [] }))).sources || [];
        if (signal?.aborted) return;
        cachedCatalogSources = catalog;
        for (const s of catalog.filter(s => (!group || s.group === group) && (!s.domains || s.domains.includes(domain)))) { const option = el('option', s.name); option.value = s.id; picker.append(option); }
        picker.value = source;
        ranking.update(catalog, group);
      }
      feed.replaceChildren();
      feed.removeAttribute('aria-busy');
      if (!data.items.length) feed.append(el('p', query || category || source || group ? t('没有匹配的资讯，试试其他栏目、信源或关键词。') : view === 'selected' ? t('暂时没有入选资讯。你可以先浏览全部动态。') : t('资讯正在陆续收录，请稍后再来。'), 'empty'));
      append(data);
    } catch (error) {
      if (signal?.aborted) return;
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
  if (hybrid) {
    document.addEventListener('visibilitychange', refreshHealth, { signal });
    const timer = setInterval(refreshHealth, 300000);
    signal?.addEventListener('abort', () => clearInterval(timer), { once: true });
  }
  await first();
}

/** A written edition's review: the overview, then each theme with links to the items it cites. */
function reviewBlock(review, items) {
  const byId = new Map();
  for (const item of items) {
    byId.set(item.id, item);
    for (const rel of item.related_items || []) {
      if (!byId.has(rel.id)) byId.set(rel.id, rel);
    }
  }
  const box = el('section', undefined, 'report-review');
  box.append(el('p', review.overview, 'report-overview'));
  for (const theme of review.themes) {
    const part = el('section', undefined, 'report-theme'), refs = el('ul', undefined, 'report-refs');
    part.append(el('h3', theme.heading), el('p', theme.summary));
    for (const id of theme.ids) {
      const item = byId.get(id);
      if (!item) continue;
      const li = el('li'), a = link(item.title, articleHref(item));
      if (hybrid) {
        a.addEventListener('click', event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          openArticleDrawer(item);
        });
      }
      li.append(a, el('small', item.source_name));
      refs.append(li);
    }
    if (refs.children.length) part.append(refs);
    box.append(part);
  }
  return box;
}

async function daily(signal) {
  pageHead(
    isAi ? t('每日 AI 与硬科技简报') : t('每日金融简报'),
    t('每天北京时间 08:00 汇总过去 24 小时的大事：一篇综述，后附本期条目。'),
    { withDomainSwitch: true }
  );
  const requested = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : '';
  const form = el('form', undefined, 'report-picker'), input = el('input'), button = el('button', t('查看日报'), 'btn btn-secondary btn-sm');
  input.type = 'date';
  input.max = today();
  input.value = requested || today();
  input.setAttribute('aria-label', t('日报日期'));
  form.append(input, button);
  form.onsubmit = event => { event.preventDefault(); if (input.value) navigate(inDomain('/daily?date=' + input.value)); };
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
      if (signal?.aborted) return;
      input.value = date;
      list.replaceChildren(...data.reports.slice(0, 14).map(r => {
        const li = el('li'), a = link('', inDomain('/daily?date=' + r.date), r.date === date ? 'active' : '');
        a.append(el('span', longDay(r.date)), el('small', !en && r.headline ? r.headline : r.mode === 'source-index' ? t('来源索引 {count} 条', { count: r.count }) : r.mode === 'review' ? t('本期 {count} 条资讯', { count: r.count }) : t('精选 {count} 条', { count: r.count })));
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
      if (signal?.aborted) return;
      // A written edition leads with its review (Chinese); its cited items and the selected list follow.
      const written = !en && report.review?.themes?.length ? report.review : null;
      summary.append(el('h2', written?.headline ? written.headline : longDay(date)));
      if (written) summary.append(el('span', longDay(date) + ' · ' + t('本期 {count} 条资讯', { count: report.items.length }), 'hint'));
      else if (report.items.length) summary.append(el('span', report.mode === 'source-index' ? t('本期收录 {count} 条资讯 · 来源索引', { count: report.items.length }) : t('本期精选 {count} 条资讯', { count: report.items.length }), 'hint'));
      top.replaceChildren(summary);
      if (report.windowStart && report.windowEnd) top.append(el('p', t('收录窗口：{start}—{end}（北京时间）', { start: stamp(report.windowStart), end: stamp(report.windowEnd) })));
      feed.replaceChildren(...report.items.map(item => row(report.mode === 'source-index' ? item : { ...item, selected: 0 }, { full: true })));
      if (report.mode === 'source-index' && report.items.length) feed.prepend(el('p', t('本期没有入选精选，以下提供普通摘要和原文入口，供你继续阅读。'), 'notice'));
      if (written) feed.prepend(reviewBlock(written, report.items), el('h3', t('本期条目'), 'report-list-title'));
      if (!report.items.length) feed.append(el('p', t('本期窗口内暂未收录可展示的资讯，请浏览今日动态或选择其他日期。'), 'empty'));
      foot.append(link(t('浏览最近动态 →'), inDomain('/all'), 'text-link'));
      if (hybrid && report.items.length) foot.append(link(t('本期归档页 →'), inDomain('/daily/' + date + (en ? '?lang=en' : '')), 'text-link'));
    } catch (error) {
      if (signal?.aborted) return;
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

async function about(signal) {
  pageHead(t('关于 FinHot'), t('FinHot 是一个独立维护的 AI 与硬科技、金融信息产品，面向产业与市场观察者、投资研究者。'));
  const column = el('div', undefined, 'stack layout-single'), intro = el('section', undefined, 'panel panel-body'), products = el('div', undefined, 'product-cards');
  intro.append(el('p', t('市场消息、公司披露和研究观点，往往分散在不同平台。我们希望把发现信息、读懂要点、回到原文这几步，做得更顺手。'), 'lead'));
  for (const [name, description, url] of [[t('FinHot 金融资讯'), t('发现市场、公司与研究动态，按来源检索，阅读每日简报。'), inDomain('/all')], [t('FinMap 公司研究'), t('追踪公司动态，探索产业链与核心技术。'), 'https://map.finhot.fun/']]) {
    const card = url.startsWith('https:') ? external('', url, 'product-card') : link('', url, 'product-card');
    card.append(el('h2', name + ' ↗'), el('p', description));
    products.append(card);
  }
  intro.append(products);
  const principles = el('section', undefined, 'panel panel-body prose');
  principles.append(
    el('h2', t('我们的信息原则')), el('p', t('来源可追溯：保留发布机构、来源时间与原文入口。摘要有边界：只依据实际取得的材料整理，PDF 片段会注明范围。判断属于读者：资讯与研究观点不构成投资建议。')),
    el('h2', t('收录范围与更新')), el('p', t('覆盖公开市场资讯、上市公司公告、公司与行业研报，以及政策和宏观数据。公告采用抽样收录，完整披露请以巨潮、交易所等原始平台为准；付费研报与实时行情不在承诺覆盖范围内。')), el('p', t('不同信源按各自频率更新，发布时间与收录时间分别标注。来源故障或处理排队可能带来延迟。尚无摘要时保留原题和原文链接；中文摘要与经过评审的精选摘要分别标注。')),
    el('h2', t('如何使用 FinHot')), el('p', t('在金融动态中按栏目、信源或关键词查找信息；搜索覆盖近期收录的标题、原题和摘要，最多 5,000 条，不含原文全文。每日简报在北京时间 08:00 汇总过去 24 小时的大事，写成一篇综述，后附本期条目和原文入口。')), el('p', t('已经公开的独立文章和日报保留归档地址，实际撤回或下架的内容会移除。你也可以通过 RSS 在自己的阅读器中订阅精选。')),
    el('h2', t('交流与合作')), el('p', t('FinHot 由维护者独立运营。欢迎产品建议、信源推荐与合作交流。')), link('hello@finhot.fun ↗', 'mailto:hello@finhot.fun'), el('p', t('内容更正、来源展示调整或删除请求，也可以通过站内反馈提交。')), link(t('提交反馈 →'), '/feedback'),
  );
  const sources = el('section', undefined, 'panel panel-body');
  sources.id = 'sources';
  sources.append(el('h2', t('公开信源')), el('p', t('以下是收录入口，展示不代表与来源机构存在合作或背书关系。'), 'hint'));
  column.append(intro, principles, sources);
  app.append(column);
  try {
    const data = await getSourcesCatalog();
    if (signal?.aborted) return;
    cachedCatalogSources = data.sources;
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
        const sDomain = s.domains?.includes('ai') && !s.domains?.includes('finance') ? 'ai' : 'finance';
        const sHref = '/all?source=' + encodeURIComponent(s.id) + (sDomain === 'ai' ? '&domain=ai' : '');
        const line = el('div', undefined, 'source-row'), info = el('span'), late = s.failed ? el('span', t('更新暂有延迟'), 'is-late') : el('span', t('源内最新 {time}', { time: valid(s.latest_published_at) ? stamp(s.latest_published_at) : t('待核实') }));
        info.append(late, link(t('浏览收录 →'), sHref));
        line.append(safeUrl(s.homepage) ? external(s.name + ' ↗', s.homepage) : el('span', s.name), info);
        box.append(line);
      }
      sources.append(box);
    }
  } catch { if (!signal?.aborted) sources.append(el('p', t('信源目录暂时无法加载，请稍后重试。'), 'hint')); }
}

async function policy(name, signal) {
  pageHead(name === 'terms' ? t('使用说明') : t('隐私说明'), t('维护署名：FinHot 维护者 · 联系渠道：站内反馈'));
  const panel = el('section', undefined, 'panel panel-body prose layout-single');
  app.append(panel);
  const response = await fetch(`/${name}.txt`, { signal });
  if (!response.ok) throw new Error(t('说明加载失败'));
  if (en) panel.append(el('p', t('以下为已发布的中文说明。'), 'hint'));
  const text = await response.text(), body = el('div');
  if (signal?.aborted) return;
  body.lang = 'zh-CN';
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

const routes = {
  '/': home,
  '/all': explore,
  '/daily': daily,
  '/about': about,
  '/terms': signal => policy('terms', signal),
  '/privacy': signal => policy('privacy', signal),
  '/feedback': feedback,
  '/admin': admin,
};

function syncChrome() {
  const titles = {
    '/all': isAi ? t('AI 与硬科技动态') : t('金融动态'),
    '/daily': isAi ? t('每日 AI 与硬科技简报') : t('每日金融简报'),
    '/about': t('关于 FinHot'),
    '/feedback': t('反馈与更正'),
    '/terms': t('使用说明'),
    '/privacy': t('隐私说明'),
    '/admin': t('管理员入口'),
  };
  const navPath = path.startsWith('/daily') ? '/daily' : path;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === navPath));

  for (const a of document.querySelectorAll('.site-footer a[data-footer-discover]')) {
    a.textContent = isAi ? t('AI 动态') : t('金融动态');
  }
  const slogan = document.querySelector('.footer-brand p');
  if (slogan) slogan.textContent = isAi ? t('从 AI 与硬科技信息，到研究起点。') : t('从金融信息，到研究起点。');
  for (const a of document.querySelectorAll('.site-footer a[data-footer-rss], link[rel="alternate"][type="application/rss+xml"]')) {
    a.setAttribute('href', isAi ? '/feed/ai.xml' : '/feed.xml');
  }
  document.querySelector('link[rel="alternate"][type="application/rss+xml"]')?.setAttribute('title', isAi ? 'FinHot ' + domainNames.ai : 'FinHot ' + t('金融精选'));
  for (const a of document.querySelectorAll('.site-footer a[data-domain-link]')) {
    const base = a.getAttribute('data-domain-link');
    if (base) a.setAttribute('href', inDomain(base));
  }
  document.title = path === '/' ? (isAi ? t('FinHot · 最新 AI 与硬科技资讯与每日简报') : t('FinHot · 最新金融资讯与每日简报')) : (titles[path] || t('这个页面不存在')) + ' · FinHot';
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) canonical.href = 'https://finhot.fun' + (path === '/' ? '/' : path) + (domain === 'ai' && ['/', '/all', '/daily'].includes(path) ? '?domain=ai' : '');
  syncTerminalFrame();
}

let activeRouteAbort = null;

async function renderCurrentRoute() {
  closeArticleDrawer();
  syncLocation();
  // Older homepage links carried explorer filters; keep them working.
  if (path === '/' && ['view', 'q', 'category', 'source', 'group'].some(key => params.has(key))) {
    history.replaceState(null, '', '/all' + location.search);
    syncLocation();
  }
  if (activeRouteAbort) activeRouteAbort.abort();
  const abortController = new AbortController();
  activeRouteAbort = abortController;

  app.classList.toggle('page-home', path === '/');
  app.classList.toggle('page-workbench', ['/', '/all', '/daily'].includes(path));
  syncChrome();
  app.replaceChildren();
  try {
    await (routes[path] || missing)(abortController.signal);
  } catch (error) {
    if (!abortController.signal.aborted) {
      app.append(el('p', failure(error), 'empty error'));
    }
  }
}

function navigate(href, { replace = false } = {}) {
  const target = new URL(href, location.href);
  if (target.origin !== location.origin) {
    location.assign(target.href);
    return;
  }
  const targetPath = target.pathname.replace(/\/$/, '') || '/';
  if (!Object.hasOwn(routes, targetPath)) {
    location.assign(target.href);
    return;
  }
  if (target.searchParams.has('domain') && Object.hasOwn(domainNames, target.searchParams.get('domain'))) {
    rememberDomain(target.searchParams.get('domain'));
  }
  const nextUrl = target.pathname + target.search + target.hash;
  const currentUrl = location.pathname + location.search + location.hash;
  if (replace) history.replaceState(null, '', nextUrl);
  else if (nextUrl !== currentUrl) history.pushState(null, '', nextUrl);
  window.scrollTo({ top: 0, behavior: 'instant' });
  renderCurrentRoute();
}

// Intercept same-origin clicks on SPA routes (left rail, footer, chips, view tabs, archive links)
// so transitions happen in-place without flashing or reloading the outer shell.
document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target.closest?.('a[href]');
  if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
  let url;
  try { url = new URL(anchor.href, location.href); } catch { return; }
  if (url.origin !== location.origin) return;
  const targetPath = url.pathname.replace(/\/$/, '') || '/';
  if (!Object.hasOwn(routes, targetPath)) return;
  event.preventDefault();
  navigate(url.pathname + url.search + url.hash);
});

// Intercept the global header search form so searching stays inside the SPA shell.
document.addEventListener('submit', event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.classList.contains('suite-global-search')) return;
  event.preventDefault();
  const q = (form.querySelector('input[name="q"]')?.value || '').trim();
  const u = new URL('/all', location.origin);
  if (q) u.searchParams.set('q', q);
  if (domain === 'ai') u.searchParams.set('domain', 'ai');
  if (en) u.searchParams.set('lang', 'en');
  navigate(u.pathname + u.search);
});

window.addEventListener('popstate', () => {
  renderCurrentRoute();
});

await renderCurrentRoute();
