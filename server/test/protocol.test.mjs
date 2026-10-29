import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NegotiatingTransport, ResponseCache, MODERN_VERSION, modernParams, encodeHeader, decodeHeader, validateResult } from '../dist/protocol.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'skillar-modern-'));
  await mkdir(join(root,'example'));
  await writeFile(join(root,'example/SKILL.md'), '---\nname: example\ndescription: Protocol fixture\n---\nHello\n');
  t.after(() => rm(root,{recursive:true,force:true}));
  return new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{...process.env,SKILLAR_SKILL_ROOTS:`fixture=${root}`}});
}
function raw(transport) {
  let id = 0; const pending = new Map();
  transport.onmessage = message => { const p = pending.get(message.id); if(p) { pending.delete(message.id); clearTimeout(p.timer); p.resolve(message); } };
  return async (method,params={}) => {
    const current=++id;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('RPC timeout')),3000);
      pending.set(current,{resolve,timer});
      transport.send({jsonrpc:'2.0',id:current,method,params}).catch(reject);
    });
  };
}
test('modern wire works without initialize, validates metadata and returns cache fields', async t => {
  const transport=await fixture(t); const call=raw(transport); await transport.start();t.after(()=>transport.close());
  assert.equal((await call('skills/list')).error.code,-32602);
  const discovery=(await call('server/discover',modernParams())).result;
  assert.deepEqual(discovery.supportedVersions,[MODERN_VERSION]);
  assert.equal(discovery.capabilities.extensions['io.modelcontextprotocol/skills'].directoryRead,true);
  const wrong=modernParams();wrong._meta['io.modelcontextprotocol/protocolVersion']='2099-01-01';
  assert.equal((await call('skills/list',wrong)).error.code,-32022);
  assert.equal((await call('skills/list',{_meta:{'io.modelcontextprotocol/protocolVersion':MODERN_VERSION}})).error.code,-32602);
  const listing=(await call('skills/list',modernParams())).result;
  const uri=listing.skills[0].uri;
  for(const [method,params] of [['skills/get',{uri}],['resources/read',{uri}],['resources/list',{}],['tools/list',{}]]) {
    const result=(await call(method,modernParams(params))).result;
    assert.equal(result.resultType,'complete');assert.equal(result.cacheScope,'private');assert.ok(result.ttlMs>=0);
  }
  assert.equal((await call('skills/list')).error.code,-32602,'metadata is still mandatory after discovery');
});
test('negotiated stdio uses modern metadata, legacy clients still work',async t=>{
  const transport=new NegotiatingTransport(await fixture(t));const client=new Client({name:'test',version:'1'});
  await client.connect(transport);t.after(()=>client.close());assert.equal(transport.modern,true);
  const result=await client.request({method:'skills/list'},z.object({skills:z.array(z.any()),ttlMs:z.number(),cacheScope:z.string()}));
  assert.equal(result.skills.length,1);assert.equal(result.cacheScope,'private');
});
test('probe falls back for legacy errors and silence, but not recognized modern errors',async()=>{
  for(const code of [-32601,-32602,'timeout',-32022]) {
    const sent=[];let inner;
    inner={start:async()=>{},close:async()=>{},send:async m=>{sent.push(m.method);if(m.method==='server/discover'&&code!=='timeout')queueMicrotask(()=>inner.onmessage({jsonrpc:'2.0',id:m.id,error:{code,message:'fixture'}}));if(m.method==='initialize')queueMicrotask(()=>inner.onmessage({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{},serverInfo:{name:'fixture',version:'1'}}}));}};
    const transport=new NegotiatingTransport(inner,10);const client=new Client({name:'test',version:'1'});
    if(code===-32022) {await assert.rejects(client.connect(transport));assert.deepEqual(sent,['server/discover']);}
    else {await client.connect(transport);assert.equal(transport.modern,false);assert.ok(sent.includes('initialize'));}
    await client.close();
  }
});
test('modern results reject missing cache hints; legacy responses remain accepted',()=>{
  assert.throws(()=>validateResult({resultType:'complete'},true,true));
  assert.throws(()=>validateResult({resultType:'unknown'},false,false));
  assert.doesNotThrow(()=>validateResult({},false,true));
  assert.doesNotThrow(()=>validateResult({resultType:'complete',ttlMs:0,cacheScope:'private'},true,true));
});
test('cache honors expiry, method/params, isolation, mutation and invalidation',async()=>{
  let now=0,calls=0;const a=new ResponseCache(()=>now),b=new ResponseCache(()=>now);
  const get=()=>Promise.resolve({resultType:'complete',ttlMs:10,cacheScope:'private',data:++calls});
  const first=await a.read('skills/list',{},get); first.data=999;
  assert.equal((await a.read('skills/list',{},get)).data,1);
  assert.equal((await b.read('skills/list',{},get)).data,2);
  assert.equal((await a.read('skills/list',{cursor:'2'},get)).data,3);
  assert.equal((await a.read('skills/get',{},get)).data,4);
  now=10;assert.equal((await a.read('skills/list',{},get)).data,5);
  a.clear();assert.equal((await a.read('skills/list',{},get)).data,6);
  for(const hints of [{},{ttlMs:0,cacheScope:'private'},{ttlMs:-1,cacheScope:'public'},{ttlMs:10}]) {
    a.clear();let fetched=0;const fetch=async()=>({...hints,value:++fetched});
    await a.read('skills/list',{},fetch);await a.read('skills/list',{},fetch);assert.equal(fetched,2);
  }
  a.clear();let resolve;const pending=a.read('skills/list',{},()=>new Promise(r=>{resolve=r;}));a.clear();resolve({ttlMs:10,cacheScope:'private',data:999});await pending;
  assert.notEqual((await a.read('skills/list',{},get)).data,999,'in-flight results cannot undo invalidation');
});
test('cache memory budget evicts and header sentinel round trips',async()=>{
  const cache=new ResponseCache(()=>0,100);let calls=0;
  const get=async()=>({ttlMs:10,cacheScope:'private',value:'x'.repeat(100),calls:++calls});
  await cache.read('skills/list',{},get);await cache.read('skills/list',{},get);assert.equal(calls,2);
  for(const value of ['abc','한글',' padded ','=?base64?literal?=','line\nbreak'])assert.equal(decodeHeader(encodeHeader(value)),value);
});
