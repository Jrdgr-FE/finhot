const names={"json-wscn-articles":"Wallstreetcn · Global Markets","json-eastmoney-news":"Eastmoney · Financial News","web-csrc-news":"China Securities Regulatory Commission · News","fed-monetary":"Federal Reserve · Monetary Policy","fed-bankinginfo":"Federal Reserve · Banking Supervision","ecb-press":"European Central Bank · News","bis-pressrels":"BIS · Press Releases","stats-data-release":"National Bureau of Statistics of China · Releases","stats-interpretation":"National Bureau of Statistics of China · Analysis","bankingdive":"Banking Dive","sse-market-news":"Shanghai Stock Exchange · Market and Company News","cninfo-financial":"CNINFO · Financial Results and Forecasts","cninfo-company":"CNINFO · Corporate Announcements","21jingji-company":"21st Century Business Herald · Companies","21jingji-capital":"21st Century Business Herald · Securities","eastmoney-research-0":"Eastmoney Research · Companies","eastmoney-research-1":"Eastmoney Research · Industries","eastmoney-research-2":"Eastmoney Research · Strategy and Macro","sina-market":"Sina Finance · Markets","cnbc-markets":"CNBC · Markets","cnbc-earnings":"CNBC · Earnings","bbc-business":"BBC · Business","apple-newsroom":"Apple · Newsroom","cfa-enterprising-investor":"CFA Institute · Enterprising Investor","nyfed-liberty-street":"New York Fed · Liberty Street Economics","bis-research":"BIS · Research","fed-feds-notes":"Federal Reserve · FEDS Notes"};
                                         
export const contentLanguage=(value            )                =>value==='zh-CN'?'zh-CN':'en';
const isEnglish=(value                      )=>!!value&&!/[\u3400-\u9fff]/u.test(value);
export function sourceName(id       ,name       ,lang                ='en'){
  return lang==='zh-CN'?name:(names                         )[id]||(isEnglish(name)?name:id);
}
export function localizeItem                                                                                                                                                  (item  ,lang                ='en'){
  if(lang==='zh-CN')return {...item,translation_pending:false};
  const title=item.title_en||(isEnglish(item.original_title)?item.original_title:isEnglish(item.title)?item.title:''),summary=item.summary_en||(isEnglish(item.summary)?item.summary:'');
  return {...item,title:title||'English translation pending',summary,source_name:sourceName(item.source_id,item.source_name),
    translation_pending:!title||!!item.summary&&!summary};
}
export function englishMaterial(scope       ){
  const pdf=/^PDF 前 (\d+) 页（共 (\d+) 页）/.exec(scope);
  return pdf?`First ${pdf[1]} of ${pdf[2]} PDF pages`:isEnglish(scope)?scope:scope?'Extracted source material':'';
}
export const englishCategories                      ={policy:'Policy & regulation',macro:'Economic data',market:'Market updates',earnings:'Earnings',corporate:'Company news',research:'Research',banking:'Banking',securities:'Securities',insurance:'Insurance',fund:'Asset management',institution:'Institutions'};
