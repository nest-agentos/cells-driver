import {expect,it,vi} from 'vitest';
import {CellsHttpClient} from '../src/http-client';
it.each(['EBUSY','ENOENT','EACCES','ECONFLICT'])('preserves %s across a formal rejected operation',async code=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:false,error:{code,outcome:'not-committed'}}),{status:200}));
    const client=new CellsHttpClient(new URL('http://node/'),fetcher as typeof fetch);
    await expect(client.call('project_exec',{}, {timeout:1000})).rejects.toMatchObject({code,remoteCode:code,outcome:'not-committed'});
    expect(fetcher).toHaveBeenCalledOnce();
});
it('preserves HTTP rejection classification without reflecting an unsafe code or body',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({code:'ENOENT'}),{status:404}));
    const client=new CellsHttpClient(new URL('http://node/'),fetcher as typeof fetch);
    await expect(client.call('project_read',{}, {timeout:1000})).rejects.toMatchObject({code:'ENOENT',outcome:'not-committed'});
    fetcher.mockImplementation(async()=>new Response(JSON.stringify({ok:false,error:{code:'PRIVATE BODY',outcome:'partial'}}),{status:200}));
    await expect(client.call('project_exec',{}, {timeout:1000})).rejects.toMatchObject({code:'EIO',remoteCode:'CELLS_OPERATION_FAILED',outcome:'unknown'});
});
