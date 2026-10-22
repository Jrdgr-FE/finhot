import assert from 'node:assert/strict';
import {test} from 'node:test';
import redirect from '../../ecs/redirect-worker.ts';
test('published aliases preserve article paths and query parameters on the canonical HTTPS origin',async()=>{
  for(const host of ['www.finhot.fun','test.finhot.fun'])for(const method of ['GET','HEAD']){
    const response=await redirect.fetch(new Request(`http://${host}:8080/articles/abc?q=%E5%85%AC%E5%8F%B8&group=company`,{method}));
    assert.equal(response.status,308);assert.equal(response.headers.get('location'),'https://finhot.fun/articles/abc?q=%E5%85%AC%E5%8F%B8&group=company');assert.equal(response.body,null);
  }
});
test('alias routing neither accepts unrelated hosts nor forwards feedback bodies across origins',async()=>{
  assert.equal((await redirect.fetch(new Request('https://outside.invalid/'))).status,404);
  const response=await redirect.fetch(new Request('https://test.finhot.fun/api/feedback',{method:'POST',body:'private feedback'}));
  assert.equal(response.status,405);assert.equal(response.headers.get('location'),null);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('allow'),'GET, HEAD');
});
test('the main HTTP origin redirects to HTTPS without capturing the main HTTPS website',async()=>{
  const response=await redirect.fetch(new Request('http://finhot.fun/all?group=research'));
  assert.equal(response.status,308);assert.equal(response.headers.get('location'),'https://finhot.fun/all?group=research');
  assert.equal((await redirect.fetch(new Request('https://finhot.fun/'))).status,404);
});
