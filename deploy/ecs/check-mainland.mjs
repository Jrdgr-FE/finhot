// Anonymous Globalping HTTP checks. Only public URLs are sent; no credentials or paid credits.
import fs from 'node:fs/promises';
import path from 'node:path';

const args=process.argv.slice(2),base=new URL(args[0]||'https://finhot-free.<your-subdomain>.workers.dev');
const directory=path.resolve(args[1]||'.data/ops/mainland');
if(base.protocol!=='https:'||base.username||base.password)throw new Error('A public HTTPS URL is required');
const paths=args.slice(2).length?args.slice(2):['/all?group=company','/api/items?all=1&group=company'];
if(paths.length>5||paths.some(p=>!p.startsWith('/')||p.startsWith('//')||p.includes('/_sync/')||p.includes('/admin')))throw new Error('Use at most five public paths');
const locations=[
  {country:'CN',city:'Guilin',asn:4134,limit:1},
  {country:'CN',city:"Xi'an",asn:4134,limit:1},
  {country:'CN',city:'Shanghai',asn:17621,limit:1},
  {country:'CN',city:'Tianjin',asn:4837,limit:1},
  {country:'CN',city:'Beijing',asn:9808,limit:1},
  {country:'CN',city:'Yangzhou',asn:56046,limit:1},
];
await fs.mkdir(directory,{recursive:true,mode:0o700});
let previous;const summary=[];
for(let index=0;index<paths.length;index++){
  const url=new URL(paths[index],base);
  if(url.origin!==base.origin)throw new Error('Only same-origin public paths are allowed');
  const request={type:'http',target:base.hostname,timeout:20,locations:previous||locations,
    measurementOptions:{protocol:'HTTPS',request:{method:'GET',path:url.pathname,...(url.search?{query:url.search.slice(1)}:{})}}};
  const created=await fetch('https://api.globalping.io/v1/measurements',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(20000)});
  const initial=await created.json();
  if(!created.ok)throw new Error(`Globalping returned ${created.status}: ${JSON.stringify(initial).slice(0,500)}`);
  previous=initial.id;let result;
  for(let poll=0;poll<20;poll++){
    await new Promise(resolve=>setTimeout(resolve,2000));
    const response=await fetch('https://api.globalping.io/v1/measurements/'+initial.id,{signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Cannot retrieve public measurement');
    result=await response.json();if(result.status!=='in-progress')break;
  }
  const filename=`measurement-${index+1}-${initial.id}.json`;
  await fs.writeFile(path.join(directory,filename),JSON.stringify({request,result},null,2));
  const item={path:paths[index],id:initial.id,status:result.status,probes:result.probesCount,
    results:result.results.map(r=>({city:r.probe.city,network:r.probe.network,asn:r.probe.asn,country:r.probe.country,
      status:r.result.status,httpStatus:r.result.statusCode,timings:r.result.timings,error:r.result.message||r.result.error,
      rawOutput:r.result.rawOutput}))};
  summary.push(item);console.log(JSON.stringify({...item,results:item.results.map(({rawOutput,...r})=>r)}));
}
await fs.writeFile(path.join(directory,'summary.json'),JSON.stringify({at:new Date().toISOString(),base:base.origin,
  scope:'Six community probes requested across China Telecom, China Unicom and China Mobile. Samples are point-in-time checks, not browser rendering or nationwide availability guarantees.',measurements:summary},null,2));
