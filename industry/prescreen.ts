// Rule pre-screen before any paid call: which model steps an item of an editorial source gets.
//   index: no model call; the title stays as a source index (like items past the summary window).
//   brief: the ordinary summary only; no selection scoring, so it cannot be selected.
//   full:  summary, then the selection scores (unchanged).
// The finance rules only take what 30 days of production analyses show is routine or never selected
// (2026-09-21..10-21); scripts/backtest-prescreen.ts replays them on exported analyses.
// The AI rules (ai-*) were drawn from the first 816 titles collected while those sources were
// isolated, with no analyses to replay: they only take housekeeping, marketing and templates.

export type PrescreenAction = 'index' | 'brief' | 'full';
export interface PrescreenResult { action: PrescreenAction; rule: string | null }
interface Rule { id: string; action: Exclude<PrescreenAction, 'full'>; sources: (id: string) => boolean; title: RegExp; unless?: RegExp }

const among = (...ids: string[]) => (id: string) => ids.includes(id);
const research = (id: string) => /^eastmoney-research-\d+$/.test(id);
/** Chinese market news feeds whose recaps and flash templates were never selected. */
const marketNews = among('sina-market', '21jingji-capital', '21jingji-company', 'json-eastmoney-news', 'json-wscn-articles');

/** Finance news and research sources (exchange filings and the AI sources have their own rules). */
const finance = (id: string) => !id.startsWith('ai-') && !id.startsWith('cninfo-');
/** Regulator actions on products and government bond issuance are news, not marketing. */
const FUND_RULE_NEWS = /证监会|金融监管总局|交易所.{0,6}(?:发布|通知|规则)|获批|批复|核准|准予注册|处罚|叫停|暂停|整改|办法|规定|指引|征求意见|国债|地方债|专项债|特别国债|央票/;

const ai = (id: string) => id.startsWith('ai-');
/** AI vendor newsrooms and blogs, where customer stories sit between the launches. */
/** (Google's own posts are left out: there "with Gemini 3.5 X" names a launch.) */
const aiVendor = among('ai-openai-news', 'ai-github-blog', 'ai-nvidia-blog', 'ai-nvidia-newsroom', 'ai-microsoft-research', 'ai-mistral-news', 'ai-arm-newsroom', 'ai-amd-ir');
const AI_PRODUCTS = 'ChatGPT|Codex|OpenAI|GPT[-‑]?\\d|Claude|Gemini|Copilot|Nemotron|Mistral';
/** A launch, release or deal is never taken by the AI template rules. */
const AI_NEWS = /发布|开源|首发|推出|收购|融资|\b(?:launch|unveil|announc|introduc|open(?:s|ed)?\b|open-sourc|releas|acquir|raises)/i;

/** A filing that is news (control, restructuring, enforcement, results) is never screened out. */
const MATERIAL_FILING = /重组|控制权|立案|处罚|退市|破产|重整|停牌|复牌|问询|诉讼|仲裁|业绩预|业绩快报|收购|要约|吸收合并|换股/;

const RULES: Rule[] = [
  // Exchange filings that follow a timetable: governance paperwork, fund custody, routine progress.
  { id: 'filing-routine', action: 'index', sources: among('cninfo-company'), unless: MATERIAL_FILING,
    title: /独立董事|法律意见书|核查意见|专项说明|募集资金|权益分派|担保|股东(?:大)?会|董事会决议|监事会决议|章程|持续督导|保荐|内部控制|现金管理|委托理财|闲置.{0,6}资金|质押|上市流通|股权激励|限制性股票|回购|可转债|转股|业绩说明会|投资者关系|会计师事务所|证券事务代表|辞职|注册资本|经营范围|日常关联交易|简式权益变动|减持|增持计划/ },
  // The supporting papers of one deal (often twenty at once): the report and its notice carry the news.
  { id: 'filing-deal-paperwork', action: 'index', sources: among('cninfo-company'),
    title: /董事会关于.{0,120}(?:说明|意见)$|独立财务顾问|关于本次交易.{0,30}(?:说明|承诺|意见)|法律意见|备考审阅|评估报告|审计报告|报告书（草案）摘要/ },
  // Broker research: periodic reports are indexed; comments on data and policy keep the full path.
  { id: 'research-periodic', action: 'index', sources: research, unless: /点评|快评|解读/,
    title: /周报|月报|日报|晨报|早报|周刊|周度|月度|双周|周观察|周回顾|周评|月评|行情监测|价格监测|监测周/ },
  { id: 'research-other', action: 'brief', sources: research,
    title: /^(?!.*(?:点评|快评|解读|数据|政策|策略|宏观|会议|意见|办法|规定|规则))/ },
  // Fund and wealth-product marketing: a manager buying its own funds, launches and subscription pushes.
  // The regulator's approval of a new product class and bond issuance keep the full path.
  { id: 'fund-marketing', action: 'index', sources: finance, unless: FUND_RULE_NEWS,
    title: /自购|跟投|(?:自有|固有)资金.{0,12}(?:投资|认购)|(?:基金|ETF|LOF|FOF|理财|产品|新品).{0,12}(?:发行|首发|认购|募集|发售|开售|开卖|上新|上市首日|售罄|爆款|定档)|(?:明日|今日|即将|正式|火热|重磅|起)(?:发行|发售|开售|开卖|认购)|周[一二三四五六日]开(?:售|卖)|(?:发行|发售|认购)首日|一日售罄|日光基|顶流基金经理|公募一哥/ },
  // Market recaps and flash templates.
  { id: 'market-template', action: 'brief', sources: marketNews,
    title: /午评|收评|早评|盘前|盘中|收盘|开盘|尾盘|涨停|跌停|异动|龙虎榜|融资融券|两融|主力资金|北向资金|南向资金|大宗交易|ETF|指数.{0,8}(?:涨|跌|新高|新低)|(?:涨|跌)(?:超|逾|近)\d|\d+只.{0,12}(?:涨|跌)|板块.{0,8}(?:走强|走弱|拉升|跳水|异动)|概念股|港股通|斥资.{0,12}回购/ },
  { id: 'market-template-en', action: 'brief', sources: among('cnbc-markets'),
    title: /biggest moves|premarket|midday|stock futures|Dow (?:rises|falls|jumps|drops|slides)|S&P 500 (?:rises|falls|closes)|stocks? to watch/i },
  // Sina's market feed: 163 items scored in 30 days, none selected; the same news arrives from other sources.
  { id: 'source-sina-market', action: 'brief', sources: among('sina-market'), title: /[\s\S]/ },
  // AI sources: sponsored posts, event and earnings-date notices, promotions, release tags and quotes.
  { id: 'ai-housekeeping', action: 'index', sources: ai,
    title: /^Sponsored\b|\bSponsored:|^DCD Studio|^Video Friday|^Quoting |^\[Subscriber Exclusive\]|^\[AINews\] not much happened|Earnings (?:Conference )?Call Invitation|\bto (?:Report|Announce|Host) .{0,40}(?:Results|Earnings)|(?:Conference Call|Webcast) (?:Invitation|Notice)|^Transparency data:|opens? (?:nominations|applications|registration)|nominations open|call for (?:papers|nominations|applications)|^A guide to (?:Day \d|everything)|webinar|register now|GeForce NOW|\d+% off|Prime Day|Black Friday|Cyber Monday|gift guide|双11|双十一|好价|国补|优惠|开卖|开门红|到手价|直降|邀你|报名|招募|门票|占位/i },
  // Simon Willison's release tags of his own tools ("llm-echo 0.5"): lower-case package names only.
  { id: 'ai-release-tag', action: 'index', sources: among('ai-simon-willison'), title: /^[a-z][\w.-]* \d+\.\d+(?:\.\d+)?(?:a|b|rc)?\d*$/ },
  { id: 'ai-telecom', action: 'index', sources: among('ai-datacenterdynamics'), unless: /\bAI\b|GPU|data cent(?:er|re)/i,
    title: /\b(?:[2-6]G|broadband|fibre|fiber|spectrum|mobile operator|telcos?|telecoms?|Openreach|subsea|cable theft|towers?|MVNO|Internet Exchange|DE-CIX)\b/i },
  // Customer stories in vendor blogs ("X cuts Y by 90% with ChatGPT"): the launch posts carry the news.
  { id: 'ai-customer-story', action: 'brief', sources: aiVendor, unless: /^(?:Introducing|Announcing)\b|acquir/i,
    title: new RegExp(`\\b(?:with|into|using) (?:${AI_PRODUCTS})\\b|^How [A-Z][^:]{0,60}\\b(?:is|are) (?:building|scaling|using|reimagining|transforming)\\b|\\b(?:cuts?|halves|boosts?|saves?|triples|doubles|reduces?)\\b.{0,60}(?:\\d+(?:\\.\\d+)?\\s?(?:%|x|×)|\\d+\\+? hours|from (?:weeks|days|hours))`, 'i') },
  { id: 'ai-tutorial', action: 'brief', sources: ai,
    title: /for Beginners|^How to (?:continue|use|build|set up|choose|get started|run|deploy|install|configure|create|teach|train|fine-tune|migrate)\b|^(?:Getting started|Tutorial|Guide)\b|ultimate guide|^Training and Finetuning/i },
  // Digests repeat the day's news that arrives on its own; conference appearances and brand PR are templates.
  { id: 'ai-roundup', action: 'brief', sources: ai,
    title: /^\[AINews\]|^The latest AI news we announced|\b(?:recap|roundup|round-up)\b|^This week in|早报|晚报|周报|日报|；.*；/i },
  { id: 'ai-event-pr', action: 'brief', sources: ai, unless: AI_NEWS,
    title: /大会|峰会|论坛|分会场|闭幕|开幕|大赛|挑战赛|颁奖|亮相|车展|官方合作伙伴|论文.{0,12}录用|｜(?:ACM|CVPR|ICCV|ECCV|NeurIPS|ICML|ICLR|AAAI|IJCAI|ACL|EMNLP|KDD|CNCC)\b|\bat (?:the )?(?:COLM|NeurIPS|ICML|ICLR|CVPR|OCP|SEMICON|GTC|Computex|CES|MWC|Gamescom|RoboBusiness)\b|\bSummit\b|\bExpo\b|Brand Campaign|Celebrat|Appoints .{0,40}(?:Board|Director)|Board of Directors|Declares .{0,20}Dividend/i },
  // Data-centre sites under 100 MW: local construction news, summarised but not scored.
  { id: 'ai-small-site', action: 'brief', sources: among('ai-datacenterdynamics'), unless: /\bGW\b|\bbn\b|billion|\d{3,}\s?MW/i,
    title: /\b\d{1,2}(?:\.\d+)?\s?MW\b/i },
];

export function prescreen(sourceId: string, title: string): PrescreenResult {
  for (const rule of RULES) {
    if (rule.sources(sourceId) && rule.title.test(title) && !rule.unless?.test(title)) return { action: rule.action, rule: rule.id };
  }
  return { action: 'full', rule: null };
}
