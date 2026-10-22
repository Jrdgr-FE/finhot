// Internal read-only preview of the Cloudflare frontend against the real ECS candidate API.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile),root=new URL('../../.data/build/hybrid/public/',import.meta.url);
const instance=process.env.FINHOT_ECS_INSTANCE;
if(!/^i-[a-z0-9]+$/.test(instance??''))throw Error('Instance is required');
const assets={'app.js':'application/javascript','style.css':'text/css','index.html':'text/html','logo.svg':'image/svg+xml','icon.png':'image/png','terms.txt':'text/plain','privacy.txt':'text/plain'};
let active=0;const waiters=[];
async function acquire(){if(active>=2)await new Promise(r=>waiters.push(r));active++;}
function release(){active--;waiters.shift()?.();}
createServer(async(req,res)=>{
 try {
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end('内部只读验收入口，暂不接受提交');return;}
  const url=new URL(req.url,'http://127.0.0.1');
  const route=url.pathname==='/feed.xml'?'feed.xml':/^\/api\/(items|sources|reports(?:\/\d{4}-\d{2}-\d{2})?|health)$/.exec(url.pathname)?.[1];
  if(url.pathname.startsWith('/api/')&&!route){res.writeHead(401,{'content-type':'application/json'});res.end('{"error":"内部预览仅开放公开只读接口"}');return;}
  if(route){
   if(req.url.length>4096)throw Error('Too long');
   await acquire();try{
    const path=Buffer.from(JSON.stringify('/_edge/'+route+url.search)).toString('base64');
    const command=`python3 - <<'PY'\nimport json,shlex,base64,urllib.request,urllib.error\nfrom pathlib import Path\nenv={}\nfor line in Path('/etc/finhot/candidate/api.env').read_text().splitlines():\n k,v=line.split('=',1);env[k]=shlex.split(v)[0]\np=json.loads(base64.b64decode('${path}'))\ntry:r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:3101'+p,headers={'x-finhot-origin-token':env['FINHOT_ORIGIN_TOKEN']}),timeout=20)\nexcept urllib.error.HTTPError as e:r=e\nprint(json.dumps({'status':r.status,'type':r.headers.get('content-type'),'body':base64.b64encode(r.read(2000000)).decode()}))\nPY`;
    const out=await exec('workbench',['exec','-i',instance,'-r','cn-guangzhou','-c',command,'--timeout','30','-o','json'],{maxBuffer:6000000,timeout:40000});
    const envelope=JSON.parse(out.stdout);if(envelope.exit_code!==0)throw Error('Remote request failed');
    const result=JSON.parse(envelope.stdout??envelope.output);
    res.writeHead(result.status,{'content-type':result.type??'application/json','cache-control':'no-store'});res.end(req.method==='HEAD'?undefined:Buffer.from(result.body,'base64'));
   } finally { release(); }
  } else {
   const requested=url.pathname.slice(1),name=Object.hasOwn(assets,requested)?requested:'index.html';
   let data=await readFile(new URL(name,root));
   if(name==='index.html')data=Buffer.from(data.toString().replace('<body>','<body><div style="padding:8px;text-align:center;background:#fff4d5;color:#594513">内部验收预览 · 正式域名尚未切换 · 反馈与后台提交暂关闭</div>'));
   res.writeHead(200,{'content-type':assets[name]+'; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);
  }
 } catch { res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"服务器内部预览暂时不可用"}'); }
}).listen(8810,'127.0.0.1',()=>console.log('Hybrid frontend preview: http://127.0.0.1:8810'));
