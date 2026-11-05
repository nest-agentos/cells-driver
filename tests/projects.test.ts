import { expect, it, vi } from 'vitest';
import { CellsProjectClient } from '../src/projects';
const project = {id:'p',name:'Notes',alias:'home',path:'group/notes',access:'rw' as const,revision:2,mounts:[]};
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
