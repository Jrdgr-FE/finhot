// Keep published aliases shareable while the website and its canonical URLs use one origin.
import {secureHeaders} from './security.ts';
export default {
  async fetch(request:Request):Promise<Response> {
    const url=new URL(request.url);
    const alias=['www.finhot.fun','test.finhot.fun'].includes(url.hostname);
    const insecureMain=url.hostname==='finhot.fun'&&url.protocol==='http:';
    if(!alias&&!insecureMain)return new Response('Not found',{status:404});
    if(!['GET','HEAD'].includes(request.method))return new Response('Please open https://finhot.fun to submit this request.',{status:405,headers:{allow:'GET, HEAD','cache-control':'no-store'}});
    url.protocol='https:';url.hostname='finhot.fun';url.port='';
    const headers=new Headers({location:url.href,'cache-control':'public, max-age=300'});secureHeaders(headers,new URL(request.url).protocol==='https:');
    return new Response(null,{status:308,headers});
  },
};
