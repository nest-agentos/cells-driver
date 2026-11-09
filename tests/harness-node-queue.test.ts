import {expect,it} from 'vitest';
import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {CellsProjectClient,type RemoteProject} from '../src/projects';
import {createCellsRpc} from '../src/harness/rpc';
const manifest=resolve(process.env.CELLS_MANIFEST??'../../tools/cells/Cargo.toml');
const token='queue-protocol-fixture-token-at-least-24-bytes';
const namespace='a'.repeat(64);
async function waitFor(check:()=>Promise<boolean>,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw new Error('CELLS_QUEUE_FIXTURE_TIMEOUT');}
async function stop(child:ChildProcess|undefined,signal:NodeJS.Signals='SIGTERM'){if(!child || child.exitCode!==null || child.signalCode!==null)return;const done=once(child,'exit');child.kill(signal);await done;}
async function start(binary:string,config:string){
    const child=spawn(binary,[config],{stdio:['ignore','ignore','pipe']});let output='';let endpoint='';
    child.stderr!.on('data',chunk=>{output+=String(chunk);const match=output.match(/listening on (127\.0\.0\.1:\d+)/);if(match)endpoint='http://'+match[1];});
    try{await waitFor(async()=>{if(child.exitCode!==null)throw new Error('CELLS_QUEUE_SERVER_EXITED');return !!endpoint;},15000);return {child,endpoint};}catch(error){await stop(child,'SIGKILL');throw error;}
}
function client(endpoint:string){const fetcher:typeof fetch=(url,init)=>fetch(url,{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),Authorization:'Bearer '+token}});return new CellsProjectClient(createCellsRpc(endpoint,fetcher));}
function input(id:string,text:string){return {namespace,profileId:'codex',sessionId:'native',action:'enqueue' as const,operationId:'enqueue-'+id,item:{id,text,attachments:[],createdAt:Date.now(),state:'pending' as const},input:JSON.stringify([text,[],null,null])};}
function readQueue(client:CellsProjectClient,project:RemoteProject){return client.queueSession(project,{namespace,profileId:'codex',sessionId:'native',action:'read'});}
it.skipIf(process.platform!=='linux'||!existsSync(manifest))('runs the SDK against Cells and restores its queue after SIGKILL without NestOS or replay',async()=>{
    await promisify(execFile)('cargo',['build','--quiet','--manifest-path',manifest],{timeout:90000});
    const root=await mkdtemp(join(tmpdir(),'cells-owned-queue-'));let server:Awaited<ReturnType<typeof start>>|undefined;let api:CellsProjectClient|undefined;
    try{
        for(const name of ['home','work','catalog'])await mkdir(join(root,name));
        const peer=join(root,'peer.py'),state=join(root,'native.json'),count=join(root,'turns'),finish=join(root,'finish');
        const template=await readFile(resolve(manifest,'../src/plugin/harness/tests/fixtures/queue-app-server.py'),'utf8');
        await writeFile(peer,template.replaceAll('__STATE__',JSON.stringify(state)).replaceAll('__COUNT__',JSON.stringify(count)).replaceAll('__FINISH__',JSON.stringify(finish)),{mode:0o700});
        const config=join(root,'cells.toml');await writeFile(config,`listen="127.0.0.1:0"\nserver_id="queue-protocol-fixture"\ntoken=${JSON.stringify(token)}\nexecution=true\n[projects]\nroot=${JSON.stringify(join(root,'catalog'))}\nisolation="none"\n[[exports]]\nalias="work"\npath=${JSON.stringify(join(root,'work'))}\naccess="rw"\n[[harnesses]]\nid="codex"\nkind="codex"\ncommand=${JSON.stringify(peer)}\nhome=${JSON.stringify(join(root,'home'))}\nprojects=true\n`);
        const binary=resolve(manifest,'../target/debug/cells');server=await start(binary,config);api=client(server.endpoint);
        const project=await api.register({name:'Queue',alias:'work',path:'',access:'rw'});const harness=api.harness(project);await harness.profiles();await harness.create('codex',project.id);
        await api.clientState(project,{key:namespace+'/recovery',action:'compare',expected:null,value:JSON.stringify({schema:1,text:JSON.stringify({sessionId:'native',instructionQueue:{revision:0,paused:false,items:[],receipts:[]}})})});
        await api.registerSession(project,{namespace,profileId:'codex',sessionId:'native'});
        await api.queueSession(project,input('first','fixture first'));await api.queueSession(project,input('second','fixture second'));
        await waitFor(async()=>!!(await readQueue(api!,project)).items[0]?.receipt?.turnId);
        await harness.close();await api.close();api=undefined;await writeFile(finish,'done');
        await waitFor(async()=>{try{return (await readFile(count,'utf8')).trim().split('\n').length===2;}catch{return false;}});
        await writeFile(finish,'done');api=client(server.endpoint);await waitFor(async()=>!(await readQueue(api!,project)).items.length);
        await api.queueSession(project,input('interrupted','fixture interrupted'));await api.queueSession(project,input('after-restart','fixture after restart'));
        await waitFor(async()=>!!(await readQueue(api!,project)).items[0]?.receipt?.turnId);await api.close();api=undefined;
        await stop(server.child,'SIGKILL');server=await start(binary,config);
        await waitFor(async()=>{try{return (await readFile(count,'utf8')).trim().split('\n').length===4;}catch{return false;}});
        api=client(server.endpoint);const recovered=await readQueue(api,project);
        expect(recovered.recoveries).toContainEqual(expect.objectContaining({id:'interrupted',turnId:'turn-3',outcome:'unknown',source:'system-restart'}));
        expect((await readFile(count,'utf8')).trim().split('\n')).toEqual(['turn-1','turn-2','turn-3','turn-4']);expect(recovered.owner).toBe('cells');
    }finally{await api?.close();await stop(server?.child);await rm(root,{recursive:true,force:true});}
},120000);
