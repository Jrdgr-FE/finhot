// 本站的分类体系：类别、标签词表、机构与公司名录，以及防止张冠李戴的身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 类别的 key 会出现在网址里（/all?category=…），上线后就不要再改；标签和名录可以随时增减。
//
// 本站覆盖两个领域（industry/domains.ts）：金融，以及 AI 与硬科技。每个类别属于一个领域。
// 金融的分类口径刻意与同作者的 FinMap（中国金融机构图谱）对齐：
// banking / securities / insurance 三个 key 与那边完全同名，这样读者能从一个行业的新闻
// 跳到该行业的机构图谱（见 finmap 的 /category/banking/ 等页面）。
// AI 与硬科技的词表以 AIHOT 原版（git HEAD）为底，补了芯片、算力、机器人和产业资本。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * domain 是类别所属的领域；section 是该领域日报里的分节标题（几个类别可以共用一节，按这里的顺序排）；
 * guide 告诉模型怎么归类。没归上类的资料放进领域的兜底类别（industry/domains.ts 的 fallbackCategory）。
 */
export const CATEGORIES = [
  { key: "policy", domain: "finance", label: "政策监管", section: "政策与监管", guide: "中国人民银行、国家金融监督管理总局、中国证监会、国家外汇管理局等发布的规则、办法、指引、征求意见稿、行政处罚、机构设立与吊销批复、监管人事任免" },
  { key: "macro", domain: "finance", label: "宏观数据", section: "宏观与市场", guide: "GDP、CPI、PPI、PMI、社会融资规模、新增信贷、货币供应量、利率与汇率、外汇储备等经济金融统计数据，以及货币政策操作（降准降息、MLF、逆回购、公开市场操作）" },
  { key: "market", domain: "finance", label: "市场行情", section: "宏观与市场", guide: "股票、债券、外汇、大宗商品的行情与制度变化：指数调整、资金面、北向资金、交易规则、涨跌幅与上市退市安排、注册制与发行承销规则" },
  { key: "earnings", domain: "finance", label: "财报业绩", section: "上市公司", guide: "上市公司及其子公司的财报、业绩预告、业绩快报、营收利润、经营现金流与财务数据" },
  { key: "corporate", domain: "finance", label: "公司事件", section: "上市公司", guide: "上市公司的并购重组、回购分红、股东增减持、重大订单、项目进展、诉讼与经营风险，不包含仅复述行情的材料" },
  { key: "research", domain: "finance", label: "投资研究", section: "投资研究", guide: "研究机构或作者提供有分析依据的公司、行业、策略与宏观研究；区分预测与已经实现的事实，不把评级目标价单独视为研究结论" },
  { key: "banking", domain: "finance", label: "银行", section: "银行", guide: "银行的经营与信贷投放、不良与拨备、存款与贷款利率、理财子公司、中小银行风险处置、资本补充" },
  { key: "securities", domain: "finance", label: "证券", section: "证券", guide: "证券公司经营、投行业务（IPO、再融资、并购重组）、经纪与两融、券商资管、期货公司" },
  { key: "insurance", domain: "finance", label: "保险", section: "保险", guide: "保险公司经营、保费收入、偿付能力、险资运用、产品与费率、保险中介" },
  { key: "fund", domain: "finance", label: "资管", section: "资管", guide: "公募基金、私募基金、银行理财、信托、保险资管的产品、规模、业绩、费率与人事变动" },
  { key: "institution", domain: "finance", label: "机构动态", section: "机构动态", guide: "不属于单一业态的机构层面消息：并购重组、股权变更、上市与退市、财报与业绩预告、信用评级、高管变动、股东增减持。拿不准归哪一类时放这里" },
  { key: "ai-models", domain: "ai", label: "模型", section: "模型与产品", guide: "新模型与大版本、开源权重、模型能力评测结果、API 价格与上下文长度等参数变化" },
  { key: "ai-products", domain: "ai", label: "产品与工具", section: "模型与产品", guide: "AI 应用、智能体、开发工具、API 与平台的发布和重大功能更新" },
  { key: "chips", domain: "ai", label: "芯片与半导体", section: "芯片与算力", guide: "GPU 与 AI 加速芯片、CPU、存储与 HBM、晶圆代工与先进制程、先进封装、半导体设备与材料、EDA 的发布、路线图、产能、良率与价格" },
  { key: "compute", domain: "ai", label: "算力与数据中心", section: "芯片与算力", guide: "数据中心与智算中心建设、云与算力租赁、服务器与网络、电力与散热、大额算力合同与资本开支" },
  { key: "robotics", domain: "ai", label: "机器人", section: "机器人与具身智能", guide: "人形机器人、具身智能模型、工业与服务机器人、自动驾驶的发布、量产、订单与测试" },
  { key: "ai-research", domain: "ai", label: "论文研究", section: "研究与评测", guide: "论文、技术报告、基准与数据集，以及研究机构有数据支撑的分析" },
  { key: "ai-policy", domain: "ai", label: "政策与安全", section: "政策与安全", guide: "AI 与芯片相关的法律法规、出口管制与实体清单、监管与诉讼、安全事件与对齐研究" },
  { key: "ai-opinion", domain: "ai", label: "观点与实践", section: "观点与实践", guide: "人物观点、行业分析、访谈、教程与使用经验" },
  { key: "ai-business", domain: "ai", label: "产业与资本", section: "产业与资本", guide: "AI 与硬科技公司的融资、并购、上市、财报业绩、人事变动、合作与商业动作。拿不准归哪一类时放这里" },
] as const;

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding*.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score*.md）按类型给五个维度不同的权重。每个领域有自己的一组类型。
 */
export const ITEM_TYPES_BY_DOMAIN = {
  finance: [
    "policy_release",
    "regulatory_action",
    "macro_data",
    "market_move",
    "institution_move",
    "earnings",
    "research_analysis",
    "opinion_analysis",
  ],
  ai: [
    "model_release",
    "product_launch",
    "research_paper",
    "hardware_release",
    "supply_chain",
    "capital_event",
    "policy_safety",
    "opinion_analysis",
    "tutorial_explainer",
  ],
} as const;

/** 所有领域的内容类型（数据库和接口里存的值）。 */
export const ITEM_TYPES = [
  "policy_release", "regulatory_action", "macro_data", "market_move", "institution_move", "earnings", "research_analysis",
  "opinion_analysis",
  "model_release", "product_launch", "research_paper", "hardware_release", "supply_chain", "capital_event", "policy_safety",
  "tutorial_explainer",
] as const;

// ── 标签词表（按领域） ─────────────────────────────────────────────────────────────────────

export interface TagVocabulary {
  /** 每篇资料的第一个标签必须是这些“分类标签”之一；最后一个是兜底。 */
  categoryTags: readonly string[];
  /** 可选的主题标签。 */
  topicTags: readonly string[];
  /** 可选的实体标签（机构、公司、平台）。 */
  entityTags: readonly string[];
  /** 模型常写的近义词，统一成词表里的写法。 */
  synonyms: Readonly<Record<string, string>>;
  /** 模型漏了分类标签时，按内容类型补一个。 */
  categoryByItemType: Readonly<Record<string, string>>;
}

const FINANCE_VOCABULARY: TagVocabulary = {
  categoryTags: [
    "政策/监管", "宏观/数据", "市场/行情", "处罚/风险", "并购/重组", "机构/人事",
    "财报/业绩", "产品/发行", "研究/观点", "其他",
  ],
  topicTags: [
    "货币政策", "利率", "汇率", "信贷", "不良资产", "资本补充", "理财", "资管新规",
    "注册制", "IPO", "再融资", "两融", "衍生品", "偿付能力", "险资运用",
    "养老金融", "绿色金融", "数字金融", "普惠金融", "金融科技", "反洗钱",
    "金融开放", "地方债务", "房地产金融",
  ],
  entityTags: [
    "人民银行", "金融监管总局", "证监会", "外汇局", "国家统计局",
    "工商银行", "农业银行", "中国银行", "建设银行", "交通银行", "邮储银行",
    "中信证券", "中金公司", "国泰海通", "华泰证券",
    "中国人寿", "中国平安", "中国太保", "中国信达",
    "上交所", "深交所", "北交所",
  ],
  synonyms: {
    "监管/政策": "政策/监管", 政策: "政策/监管", 监管: "政策/监管", 法规: "政策/监管", 规则: "政策/监管", 条例: "政策/监管", 办法: "政策/监管",
    处罚: "处罚/风险", 罚单: "处罚/风险", 行政处罚: "处罚/风险", 风险: "处罚/风险", 违约: "处罚/风险",
    破产: "处罚/风险", 接管: "处罚/风险", 重整: "处罚/风险", 风险处置: "处罚/风险", 爆雷: "处罚/风险",
    宏观: "宏观/数据", 数据: "宏观/数据", 统计: "宏观/数据", 经济数据: "宏观/数据", 金融数据: "宏观/数据",
    行情: "市场/行情", 市场: "市场/行情", 股市: "市场/行情", 债市: "市场/行情", 汇市: "市场/行情", 大宗商品: "市场/行情",
    人事: "机构/人事", 高管: "机构/人事", 任免: "机构/人事", 辞职: "机构/人事", 履新: "机构/人事", 换帅: "机构/人事",
    并购: "并购/重组", 重组: "并购/重组", 收购: "并购/重组", 股权: "并购/重组", 股权变更: "并购/重组",
    增持: "并购/重组", 减持: "并购/重组", 合并: "并购/重组",
    财报: "财报/业绩", 业绩: "财报/业绩", 年报: "财报/业绩", 中报: "财报/业绩", 季报: "财报/业绩", 预告: "财报/业绩",
    发行: "产品/发行", 新产品: "产品/发行", 募集: "产品/发行", 新基金: "产品/发行", 产品: "产品/发行",
    研报: "研究/观点", 研究: "研究/观点", 分析: "研究/观点", 观点: "研究/观点", 评论: "研究/观点", 解读: "研究/观点",
    公司动态: "机构/人事", 融资: "产品/发行", 投资: "并购/重组", 合作: "机构/人事",
  },
  categoryByItemType: {
    policy_release: "政策/监管",
    regulatory_action: "处罚/风险",
    macro_data: "宏观/数据",
    market_move: "市场/行情",
    institution_move: "机构/人事",
    earnings: "财报/业绩",
    research_analysis: "研究/观点",
    opinion_analysis: "研究/观点",
  },
};

// AI 与硬科技：以 AIHOT 原版为底，补芯片、算力、机器人和资本。
const AI_VOCABULARY: TagVocabulary = {
  categoryTags: [
    "模型发布", "产品更新", "论文/研究", "开源/仓库", "芯片/硬件", "算力/基础设施", "机器人/具身", "融资/并购", "财报/业绩",
    "评测/基准", "安全/对齐", "政策/监管", "教程/实践", "现象/趋势", "大佬观点", "行业动态", "非AI/通用工具", "其他",
  ],
  topicTags: [
    "Agent", "编码", "推理", "多模态", "语音", "视频", "图像生成", "RAG", "端侧", "数据/训练", "搜索", "部署/工程", "开源生态",
    "具身智能", "MCP/工具调用", "GPU", "HBM", "先进制程", "先进封装", "出口管制", "数据中心", "人形机器人", "自动驾驶", "资本开支",
  ],
  entityTags: [
    "OpenAI", "Anthropic", "DeepSeek", "DeepMind", "Google", "Meta", "Microsoft", "xAI", "Hugging Face", "GitHub", "arXiv",
    "英伟达", "AMD", "台积电", "华为",
  ],
  synonyms: {
    "教程/玩法": "教程/实践", "技巧/最佳实践": "教程/实践", "合作/生态": "行业动态", "融资/收购": "融资/并购", "公司动态": "行业动态",
    合作: "行业动态", 生态: "行业动态", 融资: "融资/并购", 收购: "融资/并购", 投资: "融资/并购", 并购: "融资/并购", 上市: "融资/并购", IPO: "融资/并购",
    财报: "财报/业绩", 业绩: "财报/业绩", 营收: "财报/业绩",
    政策: "政策/监管", 监管: "政策/监管", 法规: "政策/监管", 诉讼: "政策/监管", 安全: "安全/对齐", 对齐: "安全/对齐",
    论文: "论文/研究", 研究: "论文/研究", paper: "论文/研究", papers: "论文/研究",
    "open-source": "开源/仓库", 开源: "开源/仓库", 仓库: "开源/仓库", repo: "开源/仓库",
    教程: "教程/实践", 玩法: "教程/实践", 指南: "教程/实践", 技巧: "教程/实践", 最佳实践: "教程/实践", 实践: "教程/实践",
    产品: "产品更新", 更新: "产品更新", 发布: "模型发布", 模型: "模型发布", 趋势: "现象/趋势", 现象: "现象/趋势", 观点: "大佬观点",
    评测: "评测/基准", 基准: "评测/基准", benchmark: "评测/基准",
    芯片: "芯片/硬件", 半导体: "芯片/硬件", 硬件: "芯片/硬件", 晶圆: "芯片/硬件", 存储: "芯片/硬件",
    算力: "算力/基础设施", 智算: "算力/基础设施", 云: "算力/基础设施", 基础设施: "算力/基础设施",
    机器人: "机器人/具身", 具身: "机器人/具身",
    视频生成: "视频", 非ai: "非AI/通用工具", "non-ai": "非AI/通用工具", 通用工具: "非AI/通用工具", 工程工具: "非AI/通用工具",
    安全扫描: "非AI/通用工具", devops: "非AI/通用工具", 行业: "行业动态", 动态: "行业动态", nvidia: "英伟达", NVIDIA: "英伟达", tsmc: "台积电", TSMC: "台积电",
  },
  categoryByItemType: {
    model_release: "模型发布", product_launch: "产品更新", research_paper: "论文/研究", hardware_release: "芯片/硬件",
    supply_chain: "芯片/硬件", capital_event: "融资/并购", policy_safety: "政策/监管", opinion_analysis: "大佬观点",
    tutorial_explainer: "教程/实践",
  },
};

/** 每个领域的标签词表（领域 key 见 industry/domains.ts）。 */
export const VOCABULARY: Readonly<Record<"finance" | "ai", TagVocabulary>> = { finance: FINANCE_VOCABULARY, ai: AI_VOCABULARY };

// 金融领域的词表（加领域之前的写法，留给旧代码）。
export const CATEGORY_TAGS = FINANCE_VOCABULARY.categoryTags;
export const TOPIC_TAGS = FINANCE_VOCABULARY.topicTags;
export const ENTITY_TAGS = FINANCE_VOCABULARY.entityTags;
export const TAG_SYNONYMS = FINANCE_VOCABULARY.synonyms;
export const CATEGORY_BY_ITEM_TYPE = FINANCE_VOCABULARY.categoryByItemType;

// ── 机构与主体 ──────────────────────────────────────────────────────────────────────────

/**
 * 机构与公司主题：id → 所属领域、显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。
 * displayTag 要在该领域的实体标签词表（VOCABULARY.<领域>.entityTags）里。
 */
export const ENTITIES: Record<string, { domain: "finance" | "ai"; name: string; displayTag: string | null; aliases: string[] }> = {
  // 监管与基础设施
  pbc: { domain: "finance", name: "中国人民银行", displayTag: "人民银行", aliases: ["中国人民银行", "人民银行", "央行", "PBoC"] },
  nfra: { domain: "finance", name: "国家金融监督管理总局", displayTag: "金融监管总局", aliases: ["国家金融监督管理总局", "金融监管总局", "金监总局", "银保监会"] },
  csrc: { domain: "finance", name: "中国证监会", displayTag: "证监会", aliases: ["中国证监会", "证监会", "CSRC"] },
  safe: { domain: "finance", name: "国家外汇管理局", displayTag: null, aliases: ["国家外汇管理局", "外汇局", "SAFE"] },
  sse: { domain: "finance", name: "上海证券交易所", displayTag: null, aliases: ["上海证券交易所", "上交所", "SSE"] },
  szse: { domain: "finance", name: "深圳证券交易所", displayTag: null, aliases: ["深圳证券交易所", "深交所", "SZSE"] },
  bse: { domain: "finance", name: "北京证券交易所", displayTag: null, aliases: ["北京证券交易所", "北交所", "BSE"] },

  // 银行
  icbc: { domain: "finance", name: "中国工商银行", displayTag: "工商银行", aliases: ["中国工商银行", "工商银行", "工行", "ICBC"] },
  abc: { domain: "finance", name: "中国农业银行", displayTag: "农业银行", aliases: ["中国农业银行", "农业银行", "农行", "ABC"] },
  boc: { domain: "finance", name: "中国银行", displayTag: "中国银行", aliases: ["中国银行", "中行", "BOC"] },
  ccb: { domain: "finance", name: "中国建设银行", displayTag: "建设银行", aliases: ["中国建设银行", "建设银行", "建行", "CCB"] },
  comm: { domain: "finance", name: "交通银行", displayTag: "交通银行", aliases: ["交通银行", "交行", "BOCOM"] },
  psbc: { domain: "finance", name: "中国邮政储蓄银行", displayTag: null, aliases: ["中国邮政储蓄银行", "邮储银行", "PSBC"] },

  // 证券
  citics: { domain: "finance", name: "中信证券", displayTag: "中信证券", aliases: ["中信证券", "CITIC Securities"] },
  cicc: { domain: "finance", name: "中金公司", displayTag: null, aliases: ["中国国际金融", "中金公司", "CICC"] },
  gtja: { domain: "finance", name: "国泰海通证券", displayTag: null, aliases: ["国泰海通", "国泰君安", "海通证券"] },
  htsc: { domain: "finance", name: "华泰证券", displayTag: null, aliases: ["华泰证券", "HTSC"] },

  // 保险与资管
  chinaLife: { domain: "finance", name: "中国人寿", displayTag: "中国人寿", aliases: ["中国人寿", "国寿"] },
  pingan: { domain: "finance", name: "中国平安", displayTag: "中国平安", aliases: ["中国平安", "平安集团", "Ping An"] },
  cpic: { domain: "finance", name: "中国太保", displayTag: null, aliases: ["中国太保", "太平洋保险", "太保"] },
  cinda: { domain: "finance", name: "中国信达", displayTag: null, aliases: ["中国信达", "信达资产"] },
  chinaRe: { domain: "finance", name: "中国再保险", displayTag: null, aliases: ["中国再保险", "中再集团", "中再"] },

  // AI 与硬科技：模型与产品公司
  openai: { domain: "ai", name: "OpenAI", displayTag: "OpenAI", aliases: ["OpenAI", "ChatGPT", "Sora", "Codex", "GPT"] },
  anthropic: { domain: "ai", name: "Anthropic", displayTag: "Anthropic", aliases: ["Anthropic", "Claude"] },
  google: { domain: "ai", name: "Google", displayTag: "Google", aliases: ["Google", "DeepMind", "Gemini", "谷歌"] },
  deepseek: { domain: "ai", name: "DeepSeek", displayTag: "DeepSeek", aliases: ["DeepSeek", "深度求索"] },
  qwen: { domain: "ai", name: "千问 Qwen", displayTag: null, aliases: ["Qwen", "通义", "千问"] },
  kimi: { domain: "ai", name: "Kimi / 月之暗面", displayTag: null, aliases: ["Kimi", "月之暗面", "Moonshot"] },
  zhipu: { domain: "ai", name: "智谱 GLM", displayTag: null, aliases: ["智谱", "GLM", "Z.ai"] },
  minimax: { domain: "ai", name: "MiniMax", displayTag: null, aliases: ["MiniMax", "海螺"] },
  bytedance: { domain: "ai", name: "字节跳动 / 豆包", displayTag: null, aliases: ["字节跳动", "豆包", "Seed", "ByteDance"] },
  meta: { domain: "ai", name: "Meta", displayTag: "Meta", aliases: ["Meta", "Llama"] },
  microsoft: { domain: "ai", name: "Microsoft", displayTag: "Microsoft", aliases: ["Microsoft", "微软", "Copilot"] },
  xai: { domain: "ai", name: "xAI", displayTag: "xAI", aliases: ["xAI", "Grok"] },
  mistral: { domain: "ai", name: "Mistral", displayTag: null, aliases: ["Mistral"] },
  "hugging-face": { domain: "ai", name: "Hugging Face", displayTag: "Hugging Face", aliases: ["Hugging Face"] },

  // AI 与硬科技：芯片、算力与机器人
  nvidia: { domain: "ai", name: "英伟达", displayTag: "英伟达", aliases: ["NVIDIA", "英伟达", "Blackwell", "CUDA"] },
  amd: { domain: "ai", name: "AMD", displayTag: "AMD", aliases: ["AMD", "Instinct", "MI350"] },
  intel: { domain: "ai", name: "英特尔", displayTag: null, aliases: ["Intel", "英特尔", "Gaudi"] },
  tsmc: { domain: "ai", name: "台积电", displayTag: "台积电", aliases: ["TSMC", "台积电", "CoWoS"] },
  samsung: { domain: "ai", name: "三星电子", displayTag: null, aliases: ["Samsung", "三星"] },
  skhynix: { domain: "ai", name: "SK 海力士", displayTag: null, aliases: ["SK hynix", "海力士"] },
  micron: { domain: "ai", name: "美光", displayTag: null, aliases: ["Micron", "美光"] },
  asml: { domain: "ai", name: "ASML", displayTag: null, aliases: ["ASML", "阿斯麦"] },
  arm: { domain: "ai", name: "Arm", displayTag: null, aliases: ["Arm", "安谋"] },
  huawei: { domain: "ai", name: "华为", displayTag: "华为", aliases: ["华为", "Huawei", "昇腾", "Ascend"] },
  smic: { domain: "ai", name: "中芯国际", displayTag: null, aliases: ["中芯国际", "SMIC"] },
  tesla: { domain: "ai", name: "特斯拉", displayTag: null, aliases: ["Tesla", "特斯拉", "Optimus"] },
};

/**
 * 身份词典：摘要和标题里出现的机构，必须在原文里也出现过，否则退回原标题、丢掉摘要（防止模型张冠李戴）。
 * 金融行业尤其需要——模型很容易把「工行」写成「中国银行」，或者给一条城商行的消息套上大行的名字；
 * AI 与硬科技则容易把模型和公司张冠李戴（Gemini 写成 OpenAI、海力士写成三星）。词典不分领域，全部生效。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "pbc", name: "中国人民银行", patterns: [/中国人民银行|人民银行|央行|\bPBoC\b/i] },
  { id: "nfra", name: "国家金融监督管理总局", patterns: [/国家金融监督管理总局|金融监管总局|金监总局|银保监会/] },
  { id: "csrc", name: "中国证监会", patterns: [/中国证监会|证监会|\bCSRC\b/i] },
  { id: "safe", name: "国家外汇管理局", patterns: [/国家外汇管理局|外汇局|\bSAFE\b/] },
  { id: "icbc", name: "中国工商银行", patterns: [/工商银行|工行|\bICBC\b/i] },
  { id: "abc", name: "中国农业银行", patterns: [/农业银行|农行|\bABC\b/] },
  { id: "boc", name: "中国银行", patterns: [/中国银行|中行|\bBOC\b/] },
  { id: "ccb", name: "中国建设银行", patterns: [/建设银行|建行|\bCCB\b/i] },
  { id: "comm", name: "交通银行", patterns: [/交通银行|交行|\bBOCOM\b/i] },
  { id: "psbc", name: "中国邮政储蓄银行", patterns: [/邮政储蓄银行|邮储银行|\bPSBC\b/i] },
  { id: "citics", name: "中信证券", patterns: [/中信证券/i] },
  { id: "cicc", name: "中金公司", patterns: [/中金公司|中国国际金融|\bCICC\b/i] },
  { id: "gtja", name: "国泰海通证券", patterns: [/国泰海通|国泰君安|海通证券/] },
  { id: "htsc", name: "华泰证券", patterns: [/华泰证券|\bHTSC\b/i] },
  { id: "chinaLife", name: "中国人寿", patterns: [/中国人寿|国寿/] },
  { id: "pingan", name: "中国平安", patterns: [/中国平安|平安集团|平安银行|平安证券|平安产险|平安人寿|\bPing\s?An\b/i] },
  { id: "cpic", name: "中国太保", patterns: [/中国太保|太平洋保险|太保/] },
  { id: "cinda", name: "中国信达", patterns: [/中国信达|信达资产/] },
  { id: "chinaRe", name: "中国再保险", patterns: [/中国再保险|中再集团|中再产险|中再寿险/] },
  { id: "sse", name: "上海证券交易所", patterns: [/上海证券交易所|上交所/] },
  { id: "szse", name: "深圳证券交易所", patterns: [/深圳证券交易所|深交所/] },
  { id: "bse", name: "北京证券交易所", patterns: [/北京证券交易所|北交所/] },
  // AI 与硬科技
  { id: "openai", name: "OpenAI", patterns: [/openai|chatgpt|\bgpt-?[o\d]|\bsora\b|\bcodex\b/i] },
  { id: "anthropic", name: "Anthropic", patterns: [/anthropic|\bclaude\b/i, /\b(?:opus|sonnet|haiku)\s*\d+(?:[.\-]\d+)*\b/i, /\bfable\s*\d+(?:[.\-]\d+)*\b|\bmythos\b/i] },
  { id: "google", name: "Google / Gemini", patterns: [/google|deepmind|\bgemini\b|notebooklm|\bveo\s?\d|\bAlphaFold\b|\bAMIE\b|谷歌/i] },
  { id: "deepseek", name: "DeepSeek", patterns: [/deepseek|深度求索/i] },
  { id: "xai", name: "xAI / Grok", patterns: [/\bxai\b|\bgrok\b/i] },
  { id: "meta", name: "Meta / Llama", patterns: [/\bMeta\b/, /\bmeta\s?ai\b|\bllama\b/i] },
  { id: "microsoft", name: "Microsoft / Copilot", patterns: [/microsoft|copilot|微软/i] },
  { id: "nvidia", name: "英伟达", patterns: [/nvidia|英伟达|\bnemotron\b|\bnemo\b|\bblackwell\b|\brubin(?:\s+ultra)?\b|\bcuda\b/i] },
  { id: "qwen", name: "千问 Qwen", patterns: [/\bqwen|通义|千问/i] },
  { id: "hugging-face", name: "Hugging Face", patterns: [/hugging\s?face/i] },
  { id: "cursor", name: "Cursor", patterns: [/\bCursor\b/] },
  { id: "kimi", name: "Kimi / 月之暗面", patterns: [/\bkimi\b|月之暗面|\bmoonshot\s?ai\b/i] },
  { id: "openrouter", name: "OpenRouter", patterns: [/openrouter/i] },
  { id: "minimax", name: "MiniMax", patterns: [/minimax/i] },
  { id: "zhipu", name: "智谱 GLM", patterns: [/智谱|\bglm-?[4-9]/i] },
  { id: "hunyuan", name: "腾讯混元", patterns: [/混元|hunyuan/i] },
  { id: "bytedance", name: "字节跳动 / 豆包", patterns: [/豆包|doubao|字节跳动|bytedance/i] },
  { id: "mistral", name: "Mistral", patterns: [/mistral/i] },
  { id: "perplexity", name: "Perplexity", patterns: [/\bPerplexity\b/] },
  { id: "runway", name: "Runway", patterns: [/\brunway\b/i] },
  { id: "suno", name: "Suno", patterns: [/\bsuno\b/i] },
  { id: "midjourney", name: "Midjourney", patterns: [/midjourney/i] },
  { id: "stability-ai", name: "Stability AI", patterns: [/stability\s?ai/i] },
  { id: "elevenlabs", name: "ElevenLabs", patterns: [/eleven\s?labs/i] },
  { id: "vllm", name: "vLLM", patterns: [/\bvllm\b/i] },
  { id: "ollama", name: "Ollama", patterns: [/\bollama\b/i] },
  { id: "windsurf", name: "Windsurf", patterns: [/windsurf/i] },
  { id: "devin", name: "Devin", patterns: [/\bdevin\b/i] },
  { id: "manus", name: "Manus", patterns: [/\bmanus\b/i] },
  { id: "apple", name: "Apple AI", patterns: [/\bapple\s?(intelligence|silicon|ai)\b|苹果(智能|\s?AI)/i] },
  { id: "amazon", name: "Amazon / AWS", patterns: [/amazon|\baws\b|亚马逊/i] },
  { id: "baidu", name: "百度文心", patterns: [/百度|baidu|文心|\bernie\s?bot\b/i] },
  { id: "amd", name: "AMD", patterns: [/\bAMD\b|\binstinct\s?mi\d|超威半导体/i] },
  { id: "intel", name: "英特尔", patterns: [/\bintel\b|英特尔|\bgaudi\s?\d/i] },
  { id: "tsmc", name: "台积电", patterns: [/tsmc|台积电|台積電/i] },
  { id: "samsung", name: "三星电子", patterns: [/samsung|三星/i] },
  { id: "skhynix", name: "SK 海力士", patterns: [/sk\s?hynix|海力士/i] },
  { id: "micron", name: "美光", patterns: [/\bmicron\b|美光/i] },
  { id: "asml", name: "ASML", patterns: [/\basml\b|阿斯麦/i] },
  { id: "arm", name: "Arm", patterns: [/\bArm\b|\bARM\b(?=\s*(?:架构|芯片|CPU))|安谋/] },
  { id: "huawei", name: "华为", patterns: [/huawei|华为|昇腾|\bAscend\s?\d/i] },
  { id: "smic", name: "中芯国际", patterns: [/中芯国际|\bSMIC\b/] },
  { id: "tesla", name: "特斯拉", patterns: [/tesla|特斯拉|\boptimus\b/i] },
];

/** 这些域名上的文章，发布方就是对应的机构或公司（交易所与政府的公告页不算媒体转载；GitHub、arXiv 这类托管平台不算）。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "pbc", domains: ["pbc.gov.cn"] },
  { entityId: "nfra", domains: ["nfra.gov.cn"] },
  { entityId: "csrc", domains: ["csrc.gov.cn"] },
  { entityId: "safe", domains: ["safe.gov.cn"] },
  { entityId: "sse", domains: ["sse.com.cn"] },
  { entityId: "szse", domains: ["szse.cn"] },
  { entityId: "bse", domains: ["bse.cn"] },
  { entityId: "icbc", domains: ["icbc.com.cn", "icbc-ltd.com"] },
  { entityId: "abc", domains: ["abchina.com"] },
  { entityId: "boc", domains: ["boc.cn"] },
  { entityId: "ccb", domains: ["ccb.com"] },
  { entityId: "comm", domains: ["bankcomm.com"] },
  { entityId: "psbc", domains: ["psbc.com"] },
  { entityId: "citics", domains: ["citics.com"] },
  { entityId: "cicc", domains: ["cicc.com"] },
  { entityId: "htsc", domains: ["htsc.com.cn"] },
  { entityId: "chinaLife", domains: ["chinalife.com.cn", "e-chinalife.com"] },
  { entityId: "pingan", domains: ["pingan.com", "pingan.cn"] },
  { entityId: "cpic", domains: ["cpic.com.cn"] },
  { entityId: "cinda", domains: ["cinda.com.cn"] },
  { entityId: "chinaRe", domains: ["chinare.com.cn"] },
  { entityId: "openai", domains: ["openai.com"] },
  { entityId: "anthropic", domains: ["anthropic.com", "claude.com"] },
  { entityId: "google", domains: ["deepmind.google", "ai.google", "blog.google"] },
  { entityId: "deepseek", domains: ["deepseek.com"] },
  { entityId: "xai", domains: ["x.ai"] },
  { entityId: "meta", domains: ["ai.meta.com"] },
  { entityId: "microsoft", domains: ["microsoft.com"] },
  { entityId: "nvidia", domains: ["nvidia.com"] },
  { entityId: "qwen", domains: ["qwen.ai"] },
  { entityId: "cursor", domains: ["cursor.com"] },
  { entityId: "openrouter", domains: ["openrouter.ai"] },
  { entityId: "amd", domains: ["amd.com"] },
  { entityId: "intel", domains: ["intel.com"] },
  { entityId: "tsmc", domains: ["tsmc.com"] },
  { entityId: "skhynix", domains: ["skhynix.com"] },
  { entityId: "micron", domains: ["micron.com"] },
  { entityId: "asml", domains: ["asml.com"] },
  { entityId: "arm", domains: ["arm.com"] },
  { entityId: "samsung", domains: ["samsung.com"] },
  { entityId: "huawei", domains: ["huawei.com"] },
];

/** 原文里的这些写法也算提到了对应机构或公司。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [
  { entityId: "pingan", pattern: /@中国平安\b/ },
  { entityId: "icbc", pattern: /@中国工商银行\b/ },
  { entityId: "meta", pattern: /@AIatMeta\b/i },
  { entityId: "zhipu", pattern: /\bZhipu(?:\s+AI\b|['’]s\b)/i },
];
