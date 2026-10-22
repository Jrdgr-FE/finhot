import pack from './sources.json' with { type: 'json' };
import {CATEGORIES} from './taxonomy.ts';
import {DEFAULT_DOMAIN,domainDef,sourceDomains,type DomainKey} from './domains.ts';

const keys=new Set<string>(CATEGORIES.map(c=>c.key));
const domainOf=new Map<string,string>(CATEGORIES.map(c=>[c.key,c.domain]));
const sources=new Map(pack.sources.map(s=>[s.id,s]));
/** The domain a category belongs to (null for an unknown key). */
export function categoryDomain(category:string|null|undefined):DomainKey|null {
  return (category?domainOf.get(category) as DomainKey|undefined:undefined)??null;
}
/**
 * A provisional navigation category, independent of model budgets; it makes no selection judgement.
 * `domain` is the item's primary domain (default: the source's first); a category of another domain is not kept.
 */
export function basicCategory(sourceId:string,title:string,category?:string|null,domain?:DomainKey):string {
  const d=domain??sourceDomains(sourceId)[0]??DEFAULT_DOMAIN;
  const valid=category&&keys.has(category)&&domainOf.get(category)===d?category:null;
  if(d!=='finance')return valid??aiCategory(title)??domainDef(d).fallbackCategory;
  const source=sources.get(sourceId),group=source?.free?.group;
  if(valid&&valid!=='institution')return valid;
  if(group==='research')return 'research';
  if(/财报|年度报告|半年度报告|季度报告|业绩预告|业绩快报|业绩预增|业绩预减|净利润|营业收入/.test(title))return 'earnings';
  if(group==='company'&&/回购|分红|派息|增持|减持|并购|重组|收购|重大订单|合同|诉讼|仲裁|项目|停产|破产/.test(title))return 'corporate';
  if(valid)return valid;
  const fixed=source?.free?.category;
  return fixed&&keys.has(fixed)&&domainOf.get(fixed)===d?fixed:group==='market'?'market':'institution';
}

/** Title rules for the AI domain: the first match wins; no match falls back to the domain's fallback category. */
const AI_RULES:Array<[RegExp,string]>=[
  [/出口管制|实体清单|禁令|监管|立法|法案|诉讼|起诉|罚款|安全事件|export control|lawsuit|regulat/i,'ai-policy'],
  [/融资|估值|并购|收购|上市|IPO|财报|营收|净利润|业绩|资本开支|raises|funding|acquir|earnings|revenue/i,'ai-business'],
  [/芯片|半导体|晶圆|制程|光刻|封装|HBM|GPU|TPU|NPU|加速卡|DRAM|NAND|EDA|\bchips?\b|semiconductor|wafer|foundry/i,'chips'],
  [/数据中心|智算|算力|超算|服务器|液冷|data ?cent(?:er|re)|supercomputer/i,'compute'],
  [/机器人|具身|人形|自动驾驶|robot|humanoid|autonomous/i,'robotics'],
  [/论文|arXiv|基准|数据集|技术报告|\bpaper\b|benchmark|dataset/i,'ai-research'],
  [/教程|指南|访谈|tutorial|guide|interview/i,'ai-opinion'],
  [/大模型|模型|权重|GPT|Claude|Gemini|Llama|Qwen|DeepSeek|\bmodel\b|weights/i,'ai-models'],
  [/发布|上线|推出|更新|应用|智能体|Agent|API|launch|release|introduc/i,'ai-products'],
];
function aiCategory(title:string):string|null {
  return AI_RULES.find(([re])=>re.test(title))?.[1]??null;
}
