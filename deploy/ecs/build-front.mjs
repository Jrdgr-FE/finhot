// Build the public product home and route shells; keep the approved policies as their source.
import { stripTypeScriptTypes } from 'node:module';
import names from '../../industry/source-names.en.json' with {type:'json'};
import { cp,mkdir,copyFile,readFile,rm,writeFile } from 'node:fs/promises';
const root=new URL('../../',import.meta.url),target=new URL('.data/build/hybrid/public/',root);
// Start clean so files removed from deploy/free/public do not linger in the release.
await rm(target,{recursive:true,force:true});
await mkdir(target,{recursive:true});
await cp(new URL('deploy/free/public/',root),target,{recursive:true});
const index=new URL('index.html',target);
const home=(await readFile(index,'utf8')).replace('<head>','<head><meta name="finhot-edition" content="hybrid">');
await writeFile(index,home);
const routeShell=(await readFile(new URL('deploy/ecs/public-route-shell.html',root),'utf8')).replace('<head>','<head><meta name="finhot-edition" content="hybrid">');
const routes={
  all:['金融动态','浏览市场动态、上市公司披露与投资研究，按分类、信源和关键词查找信息。'],
  daily:['每日金融简报','每日北京时间 08:00 汇总上一更新窗口，保留来源与原文入口。'],
  about:['关于 FinHot','了解 FinHot 的金融信息产品、公开信源与信息收录原则。'],
  feedback:['反馈与更正','向 FinHot 提交产品建议、内容更正和来源展示问题。'],
  terms:['使用说明','FinHot 使用说明与信息阅读边界。'],
  privacy:['隐私说明','FinHot 的资料与反馈信息处理说明。'],
  admin:['管理员入口','FinHot 管理员入口。'],
};
for(const [route,[zhTitle,zhDescription]] of Object.entries(routes)){
  // Chinese is the default copy; i18n.js translates the annotated text for English readers.
  const title=zhTitle,description=zhDescription;
  const page=routeShell.replace(/<main[^>]*id="app"[^>]*>[\s\S]*?<\/main>/,`<main id="app" class="page"><div class="page-head"><div><h1 data-i18n="${zhTitle}">${zhTitle}</h1><p data-i18n="${zhDescription}">${zhDescription}</p></div></div><p class="loading" data-i18n="正在加载…">正在加载…</p><noscript><p class="notice">这个页面需要 JavaScript。你也可以 <a href="/feed.xml">通过 RSS 订阅</a>。</p></noscript></main>`)
    .replace(/<title[^>]*>.*?<\/title>/,`<title>${title} · FinHot</title>`)
    .replace(/<meta[^>]*name="description"[^>]*>/,`<meta name="description" content="${description}" data-i18n-content="${zhDescription}">`)
    .replace(/<meta[^>]*property="og:title"[^>]*>/,`<meta property="og:title" content="${title} · FinHot">`)
    .replace(/<meta[^>]*property="og:description"[^>]*>/,`<meta property="og:description" content="${description}" data-i18n-content="${zhDescription}">`)
    .replace('href="https://finhot.fun/"',`href="https://finhot.fun/${route}"`)
    .replace('</head>',route==='admin'?'<meta name="robots" content="noindex,nofollow"></head>':'</head>');
  const directory=new URL(route+'/',target);await mkdir(directory,{recursive:true});await writeFile(new URL('index.html',directory),page);
}
for(const [source,dest] of [['hybrid-terms.md','terms.txt'],['hybrid-privacy.md','privacy.txt']])await copyFile(new URL(`industry/pages/${source}`,root),new URL(dest,target));
for(const name of ['terms','privacy'])await copyFile(new URL(`industry/pages/hybrid-${name}.en.md`,root),new URL(`${name}.en.txt`,target));
console.log('FinHot product home and route assets prepared.');

const localized=(await readFile(new URL('packages/backend/src/publication/localized.ts',root),'utf8')).replace(/^import names[^\n]+/m,'const names='+JSON.stringify(names)+';');
await writeFile(new URL('content-language.js',target),stripTypeScriptTypes(localized));
await writeFile(new URL('deploy/free/public/content-language.js',root),stripTypeScriptTypes(localized));
