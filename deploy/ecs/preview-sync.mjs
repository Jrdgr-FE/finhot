// Local read-only preview of the protected Cloudflare deployment. No Workbench proxy or ECS origin.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
const secrets=JSON.parse(readFileSync(new URL('../../.data/ops/20261003/sync/cloudflare-secrets.json',import.meta.url),'utf8'));
const origin='https://finhot-sync-preview.<your-subdomain>.workers.dev';
createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)||req.url.startsWith('/_sync/')||req.url.startsWith('/api/admin/')){res.writeHead(403);res.end('内部预览仅供阅读');return;}
  try{
    const path=new URL(req.url,'http://127.0.0.1:8811');
    const r=await fetch(origin+path.pathname+path.search,{method:req.method,headers:{authorization:'Basic '+Buffer.from('preview:'+secrets.ADMIN_PASSWORD).toString('base64')},redirect:'error',signal:AbortSignal.timeout(15000)});
    const headers=Object.fromEntries(r.headers);delete headers['content-encoding'];delete headers['content-length'];headers['cache-control']='no-store';res.writeHead(r.status,headers);res.end(Buffer.from(await r.arrayBuffer()));
  }catch{res.writeHead(503,{'content-type':'text/plain; charset=utf-8'});res.end('预览暂时无法连接，请稍后重试');}
}).listen(8811,'127.0.0.1',()=>console.log('Cloudflare sync preview: http://127.0.0.1:8811'));
