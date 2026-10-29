import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export function sleepWakeEvidence(text, since) {
  const events = [];
  for (const line of text.split('\n')) {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})\s+(Sleep|Wake)\s+(.*)$/.exec(line);
    if (!match) continue;
    const ts = Date.parse(`${match[1]}T${match[2]}${match[3]}:${match[4]}`);
    if (!Number.isFinite(ts) || ts < since) continue;
    if (match[5] === 'Sleep' && !/Entering Sleep state/.test(match[6])) continue;
    if (match[5] === 'Wake' && !/Wake from|DarkWake to FullWake/.test(match[6])) continue;
    events.push({ time: new Date(ts).toISOString(), type: match[5], line });
  }
  events.sort((a, b) => a.time.localeCompare(b.time));
  const sleep = events.find(e => e.type === 'Sleep');
  const wake = sleep && events.find(e => e.type === 'Wake' && e.time > sleep.time);
  return sleep && wake ? { sleep, wake } : null;
}

async function main() {
  const [plugin, secondsArg, output] = process.argv.slice(2);
  const seconds = Number(secondsArg);
  if (process.platform !== 'darwin' || !plugin || !output || process.argv.length !== 5 || !Number.isFinite(seconds) || seconds < 60 || seconds > 7 * 86400)
    throw new Error('Usage on macOS: node diagnose-sleep-wake.mjs <installed-plugin> <60..604800 seconds> <output.jsonl>');
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, '', { flag: 'wx', mode: 0o600 });
  const log = event => { const line = JSON.stringify({ ts: new Date().toISOString(), ...event }); appendFileSync(output, line+'\n'); if(event.event !== 'stderr')console.log(line); };
  const root=resolve(plugin), config=JSON.parse(await readFile(join(root,'.mcp.json'),'utf8')).mcpServers.skillar;
  const clients=new Set();
  const connect = async label => {
    const client=new Client({ name:'skillar-sleep-wake-diagnostic', version:'1' });
    const transport=new StdioClientTransport({ ...config, cwd:root, stderr:'pipe' });
    transport.stderr?.on('data',bytes=>log({event:'stderr',label,text:bytes.toString()}));
    client.onerror=error=>log({event:'client-error',label,message:String(error)});
    client.onclose=()=>log({event:'client-close',label});
    clients.add(client);await client.connect(transport);log({event:'connected',label,bridge_pid:transport.pid});return client;
  };
  const call=async(client,phase,tool,args)=>{
    try {
      const result=await client.callTool({name:tool,arguments:args},undefined,{timeout:20000});
      if(result.isError)throw new Error(result.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'));
      const data=JSON.parse(result.content.find(x=>x.type==='text').text);
      log({event:'call',phase,tool,ok:true,total:data.totalMatches,uri:data.uri,release:data.release,connection_id:data.connection_id});return data;
    }catch(error){log({event:'call',phase,tool,ok:false,message:String(error)});return null;}
  };
  try {
    let client=null,uri,armedAt,deadline,lastProbe;
    const baseline=async()=>{
      const next=await connect('existing');
      try {
        const search=await call(next,'before','search_skills',{limit:1});
        const nextUri=search?.skills?.[0]?.uri;
        if(!nextUri || !await call(next,'before','load_skill',{uri:nextUri}))throw new Error('Baseline failed; sleep observation not armed');
        client=next;uri=nextUri;armedAt=Date.now();lastProbe=armedAt;deadline??=armedAt+seconds*1000;
        log({event:'armed',plugin:root,deadline:new Date(deadline).toISOString(),note:'Read-only sleep observer; checks the baseline every 60 seconds and does not suspend the computer.'});
      }catch(error){await next.close();clients.delete(next);throw error;}
    };
    const evidenceNow=()=>{
      const power=spawnSync('/usr/bin/pmset',['-g','log'],{encoding:'utf8',timeout:15000,maxBuffer:32*1024*1024});
      if(power.error || power.status!==0)throw new Error('Cannot read power transition evidence');
      return sleepWakeEvidence(power.stdout,armedAt);
    };
    await baseline();
    while(Date.now()<deadline){
      if(!client){
        try{await baseline();}catch(error){log({event:'rearm-failed',message:String(error)});await new Promise(resolve=>setTimeout(resolve,Math.min(30000,Math.max(0,deadline-Date.now()))));continue;}
      }
      let evidence=evidenceNow();
      if(!evidence && Date.now()-lastProbe>=60000){
        const healthy=await call(client,'baseline-check','search_skills',{limit:1});lastProbe=Date.now();
        // A suspended request may return after wake; preserve that bridge for the diagnostic.
        evidence=evidenceNow();
        if(!evidence && !healthy){
          log({event:'baseline-lost',note:'Connection failed before a recorded sleep/wake; rearm instead of attributing it to sleep.'});
          const old=client;client=null;await old.close();clients.delete(old);continue;
        }
      }
      if(evidence){
        log({event:'sleep-wake-observed',...evidence});
        await call(client,'after-existing','search_skills',{limit:1});
        await call(client,'after-existing','load_skill',{uri});
        try{const fresh=await connect('fresh');await call(fresh,'after-fresh','search_skills',{limit:1});await call(fresh,'after-fresh','load_skill',{uri});}
        catch(error){log({event:'fresh-connect-failed',message:String(error)});}
        log({event:'finished',scenario_executed:true,original_disconnect_cause:'not inferred from this probe alone'});return;
      }
      await new Promise(resolve=>setTimeout(resolve,Math.min(30000,Math.max(0,deadline-Date.now()))));
    }
    log({event:'observation-timeout',scenario_executed:false});process.exitCode=2;
  }finally{for(const client of clients)await client.close();}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
