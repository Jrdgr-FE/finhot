// Rule pre-screen before any paid call: which model steps an item of an editorial source gets.
//   hide:  no model call, and the item is listed nowhere (adverts and promotions; publish.ts withdraws it).
//   index: no model call; the title stays as a source index (like items past the summary window).
//   brief: the ordinary summary only; no selection scoring, so it cannot be selected.
//   full:  summary, then the selection scores (unchanged).
// The finance rules only take what 30 days of production analyses show is routine or never selected
// (2026-09-21..10-21); scripts/backtest-prescreen.ts replays them on exported analyses.
// The AI rules (ai-*) were drawn from the first 816 titles collected while those sources were
// isolated, with no analyses to replay: they only take housekeeping, marketing and templates.

export type PrescreenAction = 'hide' | 'index' | 'brief' | 'full';
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

/** Core AI & hard-tech topics required for general commercial portals (36kr, pedaily, cyzone, leiphone). */
const AI_HARDTECH_TOPIC = /AI|人工智能|大模型|模型|算力|智算|超算|数据中心|芯片|半导体|晶圆|光刻|封装|载板|存储|SSD|DRAM|NAND|HBM|GPU|TPU|NPU|EDA|RISC-V|光模块|光互连|机器人|具身|人形|灵巧手|四足|外骨骼|无人机|eVTOL|飞行汽车|低空|自动驾驶|智驾|无人驾驶|激光雷达|脑机|量子|核聚变|商业航天|火箭|卫星|3D打印|开源|多模态|推理|训练|微调|智能体|Agent|RAG|向量检索|OpenAI|Anthropic|Claude|GPT|Gemini|DeepMind|DeepSeek|深度求索|Qwen|通义|Kimi|月之暗面|智谱|MiniMax|百川|阶跃|豆包|英伟达|NVIDIA|AMD|Intel|英特尔|高通|Qualcomm|台积电|TSMC|ASML|阿斯麦|Alphabet|谷歌|Google|微软|Microsoft|苹果|Apple|Meta|亚马逊|Amazon|特斯拉|Tesla|GitLab|寒武纪|摩尔线程|沐曦|壁仞|燧原|天数智芯|昆仑芯|中芯国际|华虹|北方华创|中微|盛美|长电|华大九天|拓荆|大普微|中际旭创|宇树|智元|银河通用|傅利叶|优必选|云深处|逐际动力|星动纪元|星海图|千寻智能|自变量|光轮智能|灵心巧手|因时|帕西尼|绿的谐波|禾赛|速腾聚创|奥比中光|拓竹|大疆|影石|Rokid|XREAL|硅基流动|小马智行|文远知行|Momenta|元戎启行|Waymo|Wayve|亿航|峰飞|小鹏汇天|本源量子|国盾量子|强脑|蓝箭航天|星河动力|中科宇航|天兵科技|SpaceX|World Labs|Runway|Mistral|Hugging ?Face/i;

const RULES: Rule[] = [
  // The supporting papers of one deal (often twenty at once): the report and its notice carry the news.
  { id: 'filing-deal-paperwork', action: 'index', sources: among('cninfo-company', 'cninfo-financial'),
    title: /董事会关于.{0,160}(?:说明|意见)|关于.{0,40}(?:重大资产|发行股份|向特定对象|以简易程序|本次交易).{0,120}(?:说明|意见|承诺)|关于发行股份及支付现金购买资产.{0,30}进展公告|最近五年.{0,15}(?:被|不存在).{0,25}(?:处罚|监管措施)|全资子公司吸收合并全资孙公司|独立财务顾问|财务顾问专业意见|法律意见|备考审阅|评估报告|审计报告|鉴证报告|专项核查|核查报告|报告书（(?:草案|申报稿)）摘要|修订说明|对比说明|关于本次重大资产重组的一般风险提示|可行性分析报告|论证分析报告|摊薄即期回报|前次募集资金|科技创新领域的说明|预案.{0,12}披露的提示性公告|过渡期损益|停牌进展公告/ },
  // Exchange filings that follow a timetable: governance paperwork, fund custody, routine progress.
  { id: 'filing-routine', action: 'index', sources: among('cninfo-company', 'cninfo-financial'), unless: MATERIAL_FILING,
    title: /独立董事|法律意见书|核查意见|专项说明|募集资金|权益分派|利润分配|担保|授信额度|申请.{0,8}授信|套期保值|外汇衍生品|政府补助|收到.{0,10}退税|地震灾区捐赠|股东(?:大)?会|董事会决议|监事会决议|换届选举|职工代表|董事会秘书|专门委员会|提名委员会|补选(?:董事|监事)|章程|治理制度|议事规则|多元化政策|提质增效重回报|估值提升计划|持续督导|保荐|内部控制|现金管理|委托理财|购买.{0,8}理财|闲置.{0,6}资金|补充流动资金|置换募集资金|质押|解除质押|司法冻结|上市流通|股权激励|限制性股票|员工持股计划.{0,12}(?:解锁|锁定期)|回购|前十大(?:无限售条件)?股东|可转债|转股|业绩说明会|投资者(?:集体)?接待日|投资者关系|会计师事务所|审计机构|签字合伙人|签字注册会计师|证券事务代表|辞职|辞任|离任|离职|注册资本|经营范围|法定代表人变更|换领营业执照|换发营业执照|工商变更登记|日常关联交易|补充确认.{0,10}关联|产业基金事项基金主体|无偿划转的进展|简式权益变动|股份变动结果|表决权委托到期|减持|增持|股票交易(?:异常波动|风险提示)|询证函|报告披露提示性公告|H股公告|翌日披露|香港联交所审议|资产采购的进展|英文版/ },
  // Broker research: periodic reports are indexed; comments on data and policy keep the full path.
  { id: 'research-periodic', action: 'index', sources: research, unless: /点评|快评|解读/,
    title: /周报|月报|日报|晨报|早报|晨会|纪要|聚焦|信息速递|每日资讯|数据跟踪|高频数据|行业跟踪|周跟踪|月跟踪|半月报|双周报|季报综述|周刊|周度|月度|双周|周观察|周回顾|周评|月评|行情监测|价格监测|监测周|织物洗护香氛|双11备战手册/ },
  { id: 'research-other', action: 'brief', sources: research,
    title: /^(?!.*(?:点评|快评|解读|数据|政策|策略|宏观|会议|意见|办法|规定|规则))/ },
  // Fund and wealth-product marketing: a manager buying its own funds, launches and subscription pushes.
  // The regulator's approval of a new product class and bond issuance keep the full path.
  { id: 'fund-marketing', action: 'index', sources: finance, unless: FUND_RULE_NEWS,
    title: /自购|跟投|(?:自有|固有)资金.{0,12}(?:投资|认购)|(?:基金|ETF|LOF|FOF|理财|产品|新品).{0,12}(?:发行|首发|认购|募集|发售|开售|开卖|上新|上市首日|售罄|爆款|定档)|(?:明日|今日|即将|正式|火热|重磅|起)(?:发行|发售|开售|开卖|认购)|周[一二三四五六日]开(?:售|卖)|(?:发行|发售|认购)首日|一日售罄|日光基|顶流基金经理|公募一哥/ },
  // Non-financial wire noise, tabloid clickbait and stock-pump templates are hidden before market-template.
  { id: 'finance-wire-noise', action: 'hide', sources: finance,
    title: /《新闻联播》要闻|会见.{0,15}(?:代表团|总统|总理|外长)|同.{0,20}(?:总统|总理|国王|首相).{0,6}会谈|构建新时代.{0,15}命运共同体|首脑会议宣言|早期收获安排|炸弹(?:威胁|警报)|被拘留.{0,10}记者|微短剧专项治理|电视剧侵权|\bCBA\b|网红产品翻车|联名麻将|芒果涨疯了|气囊召回|跨越欧亚的汽车|主力资金|逆市抢筹|调仓路线图|揭秘涨停|\d+连板.{0,15}(?:无|未发生)|基本面未发生重大变化|继续停牌|股份转让评审仍在推进|参加.{0,20}(?:业绩|三季报|半年报|年报)说明会|增聘.{0,10}基金经理|Market Talk$|Lawler[:：]|MBS收益率与利差|A股热点前瞻|21健讯|AI短剧|短剧《|黄金键帽/i },
  { id: 'market-offtopic', action: 'hide', sources: among('cnbc-markets', 'wsj-markets', 'bloomberg-markets', 'ft-markets'),
    unless: /\b(?:market|stocks?|bonds?|treasur|tariff|tax|Fed|econom|trade|tech|AI|billion|million|GDP|inflation|earnings|IPO)\b/i,
    title: /\b(?:Senate|House race|ballot|gubernatorial|mayor|train crash|plane crash|Bearista|we read .{0,30} book)\b/i },
  // Market recaps and flash templates.
  { id: 'market-template', action: 'brief', sources: marketNews,
    title: /午评|收评|早评|盘前|盘中|收盘|开盘|尾盘|涨停|跌停|异动|龙虎榜|融资融券|两融|主力资金|北向资金|南向资金|大宗交易|ETF|指数.{0,8}(?:涨|跌|新高|新低)|(?:涨|跌)(?:超|逾|近)\d|\d+只.{0,12}(?:涨|跌)|板块.{0,8}(?:走强|走弱|拉升|跳水|异动)|概念股|港股通|斥资.{0,12}回购/ },
  { id: 'market-template-en', action: 'brief', sources: among('cnbc-markets'),
    title: /biggest moves|premarket|midday|stock futures|Dow (?:rises|falls|jumps|drops|slides)|S&P 500 (?:rises|falls|closes)|stocks? to watch/i },
  // Sina's market feed: 163 items scored in 30 days, none selected; the same news arrives from other sources.
  { id: 'source-sina-market', action: 'brief', sources: among('sina-market'), title: /[\s\S]/ },
  // AI sources: sponsored posts, shopping promotions and event marketing are not shown at all.
  { id: 'ai-advert', action: 'hide', sources: ai,
    title: /^Sponsored\b|\bSponsored:|^DCD Studio|webinar|register now|GeForce NOW|\d+% off|Prime Day|Black Friday|Cyber Monday|gift guide|大促|好价|国补|优惠|开卖|到手价|直降|邀你|报名|招募|门票|占位|论文分享会|AI向善行动报告|即梦短剧|共同出资成立.{0,15}公司.{0,15}注册资本1000万元/i },
  // Event and earnings-date notices, shopping-festival news, release tags and quotes stay a source index.
  { id: 'ai-housekeeping', action: 'index', sources: ai,
    title: /^Video Friday|^Quoting |^\[Subscriber Exclusive\]|^\[AINews\] not much happened|Earnings (?:Conference )?Call Invitation|\bto (?:Report|Announce|Host) .{0,40}(?:Results|Earnings)|(?:Conference Call|Webcast) (?:Invitation|Notice)|^Transparency data:|opens? (?:nominations|applications|registration)|nominations open|call for (?:papers|nominations|applications)|^A guide to (?:Day \d|everything)|双11|双十一|开门红/i },
  // Broad portals: off-topic flashes and routine stock notices are hidden.
  { id: 'ai-offtopic', action: 'hide', sources: among('ai-36kr', 'ai-pedaily', 'ai-cyzone', 'ai-leiphone'),
    unless: AI_HARDTECH_TOPIC,
    title: /[\s\S]/ },
  { id: 'ai-stock-routine', action: 'hide', sources: ai,
    title: /\d+连板|股票交易异常波动|基本面未发生重大变化|龙虎榜|主力资金|融资融券/ },
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
