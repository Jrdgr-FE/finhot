import names from '../../../../industry/source-names.en.json' with {type:'json'};
export type ContentLanguage='en'|'zh-CN';
export const contentLanguage=(value:string|null):ContentLanguage=>value==='zh-CN'?'zh-CN':'en';
const isEnglish=(value:string|undefined|null)=>!!value&&!/[\u3400-\u9fff]/u.test(value);
export function sourceName(id:string,name:string,lang:ContentLanguage='en'){
  return lang==='zh-CN'?name:(names as Record<string,string>)[id]||(isEnglish(name)?name:id);
}
export function localizeItem<T extends {title:string;summary:string;source_id:string;source_name:string;original_title?:string;title_en?:string|null;summary_en?:string|null}>(item:T,lang:ContentLanguage='en'){
  if(lang==='zh-CN')return {...item,translation_pending:false};
  const title=item.title_en||(isEnglish(item.original_title)?item.original_title:isEnglish(item.title)?item.title:''),summary=item.summary_en||(isEnglish(item.summary)?item.summary:'');
  return {...item,title:title||'English translation pending',summary,source_name:sourceName(item.source_id,item.source_name),
    translation_pending:!title||!!item.summary&&!summary};
}
export function englishMaterial(scope:string){
  const pdf=/^PDF 前 (\d+) 页（共 (\d+) 页）/.exec(scope);
  return pdf?`First ${pdf[1]} of ${pdf[2]} PDF pages`:isEnglish(scope)?scope:scope?'Extracted source material':'';
}
export const englishCategories:Record<string,string>={policy:'Policy & regulation',macro:'Economic data',market:'Market updates',earnings:'Earnings',corporate:'Company news',research:'Research',banking:'Banking',securities:'Securities',insurance:'Insurance',fund:'Asset management',institution:'Institutions',
  'ai-models':'Models','ai-products':'Products & tools',chips:'Chips & semiconductors',compute:'Compute & data centers',robotics:'Robotics','ai-research':'Research papers','ai-policy':'Policy & safety','ai-opinion':'Views & practice','ai-business':'Industry & capital'};
