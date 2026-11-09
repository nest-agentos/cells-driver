import { expect, it, vi } from 'vitest';
import { CellsProjectClient } from '../src/projects';
const project = {id:'p',name:'Notes',alias:'home',path:'group/notes',access:'rw' as const,revision:2,mounts:[]};
it.each([undefined,1])('negotiates relative channel paths while keeping older nodes compatible (%s)',async version=>{
    const call=vi.fn(async()=>({accepted:true}));
    const client=new CellsProjectClient({call,metadata:async()=>({projectChannelPaths:version}),close:vi.fn()});
    for(const operation of ['open','current'] as const) {
        await client.channel(project,operation,{cwd:'_nestos/work',scopeId:'scope'});
        expect(call).toHaveBeenLastCalledWith('project_channel_'+operation,
            expect.objectContaining({cwd:version===1?'_nestos/work':'/projects/p/_nestos/work',projectId:'p',revision:2}),undefined);
    }
});
it('shares the project revision with harness operations and restricts available workspaces',async () => {
    const call=vi.fn(async (name: string,args: Record<string,unknown>) => {
        if (name==='harness_profiles') return {epoch:'e',profiles:[
            {id:'codex',kind:'codex',projectRuntime:true,workspaces:[],capabilities:{history:true,create:true,resume:true,interrupt:true,interactions:true}},
            {id:'legacy',kind:'codex',workspaces:[{id:'host'}],capabilities:{history:true,create:true,resume:true,interrupt:true,interactions:true}}]};
        if (name==='harness_sessions') return {sessions:[],nextCursor:null};
        if (name==='harness_resume') return {outcome:'not-committed',requestId:args.requestId,code:'EACCES'};
        return {project};
    });
    const client=new CellsProjectClient({call,close:vi.fn()});
    expect(await client.register({name:'Notes',alias:'home',path:'group/notes',access:'rw'})).toEqual(project);
    const harness=client.harness(project);
    expect((await harness.profiles()).profiles.map(p=>[p.id,p.workspaces])).toEqual([['codex',[{id:'p'}]]]);
    await harness.list('codex');
    expect(call).toHaveBeenLastCalledWith('harness_sessions',{projectId:'p',revision:2,profileId:'codex'},undefined);
    await expect(harness.resume('codex','foreign')).rejects.toMatchObject({outcome:'not-committed',code:'EACCES'});
    expect(call.mock.calls.at(-1)?.[1]).toMatchObject({projectId:'p',revision:2,epoch:'e'});
});
it('rejects incomplete directory project responses before exposing them to callers',async () => {
    const client=new CellsProjectClient({call:async()=>({project:{...project,revision:0}}),close:vi.fn()});
    await expect(client.read('p')).rejects.toThrow('Invalid project descriptor');
});
it('remounts the same project using its revision and validates the returned descriptor', async () => {
    const call = vi.fn(async () => ({project: {...project, access: 'ro', revision: 3}}));
    const client = new CellsProjectClient({call, close: vi.fn()});
    expect(await client.remount(project, 'ro')).toMatchObject({id: project.id, access: 'ro', revision: 3});
    expect(call).toHaveBeenCalledExactlyOnceWith('project_remount', {projectId: 'p', revision: 2, access: 'ro'}, undefined);
    call.mockResolvedValueOnce({project: {...project, access: 'invalid', revision: 3}});
    await expect(client.remount(project, 'rw')).rejects.toThrow('Invalid project descriptor');
});
it('negotiates execution settings and rejects malformed variables before mutation', async () => {
    const execution = {profile: 'dev', variables: {GIT_AUTHOR_NAME: 'Rain Li'}};
    const call = vi.fn(async (name: string) => name === 'project_execution'
        ? {execution, profiles: [{id: 'dev', name: 'Development', user: 'li'}]} : {project: {...project, revision: 3}});
    const client = new CellsProjectClient({call, metadata: async () => ({projectExecutionEnvironment: true}), close: vi.fn()});
    expect(await client.setExecution(project, execution)).toMatchObject({revision: 3});
    expect(call).toHaveBeenLastCalledWith('project_set_execution', {projectId: 'p', revision: 2, execution}, undefined);
    call.mockClear();
    await expect(client.setExecution(project, {profile: null, variables: {'BAD=KEY': 'x'}})).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
    const old = new CellsProjectClient({call, close: vi.fn()});
    await expect(old.executionSettings(project)).rejects.toMatchObject({code: 'ECAPABILITY'});
    expect(call).not.toHaveBeenCalled();
});

it('requires an explicit Cell capability before submitting selected project context',async()=>{
 const call=vi.fn(async()=>({accepted:true})),input={cwd:'discussion',contextProjects:[{projectId:'p',revision:2}]};
 const legacy=new CellsProjectClient({call,metadata:async()=>({projectChannelPaths:1}),close:vi.fn()});
 await expect(legacy.channel(project,'open',input)).rejects.toMatchObject({code:'ECAPABILITY',remoteCode:'CELL_PROJECT_CONTEXT_REQUIRED'});expect(call).not.toHaveBeenCalled();
 const current=new CellsProjectClient({call,metadata:async()=>({projectChannelPaths:1,projectContexts:1}),close:vi.fn()});
 await current.channel(project,'open',input);expect(call).toHaveBeenCalledWith('project_channel_open',{...input,projectId:'p',revision:2},undefined);
});

it('negotiates recovery metadata and directory remount without reading the broken binding',async()=>{
    const directory={alias:'broader',path:'group/notes'},updated={...project,...directory,revision:3};
    const call=vi.fn(async(name:string)=>({project:name==='project_binding'?project:updated}));
    const client=new CellsProjectClient({call,metadata:async()=>({projectRemountPaths:1}),close:vi.fn()});
    expect(await client.binding('p')).toEqual(project);
    expect(await client.remount(project,'rw',undefined,directory)).toEqual(updated);
    expect(call).toHaveBeenCalledWith('project_remount',{projectId:'p',revision:2,access:'rw',directory},undefined);
    expect(call.mock.calls.some(([name])=>name==='project_read')).toBe(false);
});
it('does not send directory remounts to older nodes',async()=>{
    const call=vi.fn();const client=new CellsProjectClient({call,metadata:async()=>({}),close:vi.fn()});
    await expect(client.binding('p')).rejects.toMatchObject({code:'ECAPABILITY'});
    await expect(client.remount(project,'rw',undefined,{alias:'broader',path:'group/notes'})).rejects.toMatchObject({code:'ECAPABILITY'});
    expect(call).not.toHaveBeenCalled();
});

it('leaves MCP endpoint resolution to current Cells nodes while retaining legacy compatibility',async()=>{
 const input={cwd:'_nestos/work',scopeId:'scope',endpoint:'http://host-forwarded:18787/v1/channel/mcp'};
 for(const version of [undefined,1]){
  const call=vi.fn(async()=>({accepted:true}));const client=new CellsProjectClient({call,metadata:async()=>({projectChannelPaths:1,projectChannelEndpoint:version}),close:vi.fn()});
  await client.channel(project,'open',input);const sent=call.mock.calls[0] as any;
  if(version===1)expect(sent[1]).not.toHaveProperty('endpoint');else expect(sent[1].endpoint).toBe(input.endpoint);
 }
 expect(input.endpoint).toBe('http://host-forwarded:18787/v1/channel/mcp');
});
