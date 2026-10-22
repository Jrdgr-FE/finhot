import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prescreen } from '../industry/prescreen.ts';

const action = (source: string, title: string) => prescreen(source, title).action;

test('items selected in production keep the full path', () => {
  for (const [source, title] of [
    ['cninfo-company', '厦门空港 · 600897 · 厦门空港关于拟向厦门翔业集团有限公司购买翔安机场配套资产暨关联交易的公告'],
    ['cninfo-company', '路畅科技 · 002813 · 详式权益变动报告书（远卓天使、张五堂）'],
    ['cninfo-company', '方大特钢 · 600507 · 方大特钢关于披露重组报告书暨一般风险提示公告'],
    ['cninfo-company', '新华传媒 · 600825 · 关于股票交易停牌核查结果、股票交易风险提示暨复牌的公告'],
    ['cninfo-company', '广电网络 · 600831 · 关于公司被债权人申请预重整与重整暨法院决定受理预重整并指定临时管理人的公告'],
    ['cninfo-financial', '长鑫科技 · 688825 · 2026年前三季度业绩预告的自愿性披露公告'],
    ['eastmoney-research-2', '开源证券股份有限公司 · 2026年9月进出口数据点评：进出口同比增长延续高增且远超预期'],
    ['eastmoney-research-1', '万联证券股份有限公司 · 证券Ⅱ行业快评报告：公募基金运作管理制度系统性修订，权益类基金发展空间与运作灵活度双升'],
    ['21jingji-company', '茶百道“涉嫌IPO欺诈”，上市以来市值跌去约200亿港元'],
    ['json-wscn-articles', '“股债双杀”的CoreWeave——本轮AI崩盘的“风暴眼”'],
    ['cnbc-markets', "China's third-quarter economic growth quickens to 4.5% as exports surge, beating expectations"],
    ['stats-data-release', '2026年9月份居民消费价格同比上涨0.9%'],
  ]) assert.equal(action(source!, title!), 'full', title);
});

test('routine filings, deal paperwork and periodic research make no model call', () => {
  assert.deepEqual(prescreen('cninfo-company', '磁谷科技 · 688448 · 关于变更持续督导保荐代表人的公告'), { action: 'index', rule: 'filing-routine' });
  assert.equal(action('cninfo-company', '某公司 · 600000 · 关于使用部分闲置募集资金进行现金管理的进展公告'), 'index');
  assert.equal(action('cninfo-company', '拓荆科技 · 688072 · 董事会关于本次交易定价的依据及公平合理性的说明'), 'index');
  assert.equal(action('cninfo-company', '拓荆科技 · 688072 · 北京市中伦律师事务所关于拓荆科技股份有限公司发行股份及支付现金购买资产并募集配套资金的法律意见书'), 'index');
  assert.equal(action('eastmoney-research-1', '大同证券有限责任公司 · 煤炭行业周报：动力煤价突破千元，炼焦煤价高位回落'), 'index');
  // A material filing is never screened by the routine rule.
  assert.equal(action('cninfo-company', '某公司 · 600000 · 关于控股股东减持股份暨公司控制权拟发生变更的提示性公告'), 'full');
});

test('market recaps, sina and other research get a summary but no selection scores', () => {
  assert.equal(action('21jingji-capital', 'A股午评：北证50指数涨超4%，机器人、端侧AI概念集体爆发'), 'brief');
  assert.equal(action('json-eastmoney-news', '债券ETF单日成交额再创新高'), 'brief');
  assert.equal(action('cnbc-markets', 'Stocks making the biggest moves midday: Nvidia, Tesla and more'), 'brief');
  assert.equal(action('sina-market', '新加坡金管局意外维持货币政策不变 下调通胀预期'), 'brief');
  assert.equal(action('eastmoney-research-0', '某证券 · 公司深度报告：龙头地位稳固，盈利能力持续提升'), 'brief');
  // Sources without rules are untouched.
  assert.equal(action('ecb-press', 'Isabel Schnabel: Central banks on-chain'), 'full');
});

test('AI launches, deals, chips and policy keep the full path', () => {
  for (const [source, title] of [
    ['ai-openai-news', 'Introducing GPT-6.1 Sol'],
    ['ai-openai-news', 'OpenAI acquires Orchestra Bio'],
    ['ai-openai-news', 'Atlassian and OpenAI expand partnership to turn enterprise knowledge into action'],
    ['ai-deepmind-blog', 'Intelligent transcription with Gemini 3.5 Transcribe'],
    ['ai-huggingface-blog', 'Apertus 1.5 Release Notes'],
    ['ai-huggingface-blog', 'Welcome Muse Spark Open: open-weight frontier multimodal mixture-of-experts model from Meta'],
    ['ai-mistral-news', 'Voxtral 3'],
    ['ai-simon-willison', 'Anthropic tells investors quarterly revenue up nearly 50% to $16.8bn ahead of IPO'],
    ['ai-techcrunch', 'Otter AI raises $320M from General Catalyst’s growth fund for its meeting tool'],
    ['ai-nvidia-blog', 'OCP Global Summit: Amid Ecosystem Adoption, NVIDIA Opens Vera Rubin Architecture to Help Scale AI Factories'],
    ['ai-qbitai', '达摩院玄铁出席RISC-V中国峰会，首发车规产品路线图'],
    ['ai-datacenterdynamics', 'OVHcloud has 110MW of data center capacity up for grabs'],
    ['ai-datacenterdynamics', 'Amazon pledges €16bn investment in Germany in 2027'],
    ['ai-ieee-spectrum-ai', 'How to Stop AI Agents From Secretly Collaborating'],
    ['ai-eu-digital-strategy', 'First harmonised standard supporting the AI Act published in the Official Journal'],
  ]) assert.equal(action(source!, title!), 'full', title);
});

test('AI housekeeping, customer stories, digests and event PR are screened', () => {
  assert.deepEqual(prescreen('ai-ieee-spectrum-robotics', 'Video Friday: Meet Microduck'), { action: 'index', rule: 'ai-housekeeping' });
  assert.equal(action('ai-skhynix-newsroom', 'Q3 2026 Earnings Conference Call Invitation'), 'index');
  assert.equal(action('ai-leiphone', '全年最优惠！真正的双11今晚8点天猫开卖'), 'index');
  assert.deepEqual(prescreen('ai-simon-willison', 'llm-tools-datasette 0.1.1'), { action: 'index', rule: 'ai-release-tag' });
  assert.equal(action('ai-datacenterdynamics', 'Cable theft causes Openreach broadband outage for thousands in Thurnscoe, UK'), 'index');
  assert.equal(action('ai-openai-news', 'Sophos cuts threat investigation time by 96% with OpenAI Daybreak'), 'brief');
  assert.equal(action('ai-openai-news', 'How Jump Trading is scaling quant research with ChatGPT'), 'brief');
  assert.equal(action('ai-github-blog', 'GitHub Copilot app for Beginners: How to build custom workflows with canvases'), 'brief');
  assert.equal(action('ai-latent-space', '[AINews] Claude Haiku 5.5 — better than GPT-6 Luna at the same pricing'), 'brief');
  assert.equal(action('ai-qbitai', '2026物理AI与世界模型大会医疗健康世界模型分会场在南京举行'), 'brief');
  assert.equal(action('ai-amd-ir', 'AMD Appoints Tim Ryan to Board of Directors'), 'brief');
  assert.equal(action('ai-datacenterdynamics', 'Chief Telecom breaks ground on 16MW data center in Taiwan'), 'brief');
  // Version-looking titles outside Simon Willison's tags are launches.
  assert.equal(action('ai-the-decoder', 'Claude 5.5'), 'full');
});
