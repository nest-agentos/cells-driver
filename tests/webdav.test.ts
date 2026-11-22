import { describe, expect, it, vi } from 'vitest';
import { WebDavBackend, createCellsDriver } from '../src';
import { davRoot, davUrl, hrefPath } from '../src/files/webdav/paths';
import { multistatus } from '../src/files/webdav/xml';

const endpoint = 'https://dav.example/dav/docs/';
const props = (href: string, directory = false, revision = '&quot;v1&quot;') => `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype>${directory ? '<D:collection/>' : ''}</D:resourcetype><D:getetag>${revision}</D:getetag><D:getcontentlength>4</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
const xml = (...rows: string[]) => `<D:multistatus xmlns:D="DAV:">${rows.join('')}</D:multistatus>`;
function fixture(options: { readonly?: boolean; failPut?: number | 'network'; locks?: boolean; structuralVersions?: boolean; failLock?: number; putCode?: string } = {}) {
    const calls: Array<{ method: string; url: string; headers: Headers }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? 'GET', path = new URL(String(url)).pathname;
        calls.push({ method, url:String(url), headers:new Headers(init?.headers) });
        if (method === 'OPTIONS') {
            const allow = options.readonly ? 'OPTIONS, GET, PROPFIND' : 'OPTIONS, GET, PROPFIND, PUT, MKCOL, MOVE, DELETE' + (options.locks ? ', LOCK, UNLOCK' : '');
            const headers = new Headers({Allow:allow, DAV:options.locks?'1, 2':'1'});
            if (options.structuralVersions) headers.set('x-cells-dav-structural-conditions', 'if-match');
            return new Response(null, {headers});
        }
        if (method === 'PROPFIND') return new Response(xml(props(path, !path.endsWith('.md')), ...(new Headers(init?.headers).get('depth') === '1' ? [props(path+'note.md')] : [])), {status:207});
        if (method === 'GET') return new Response('text', {headers:{ETag:'"v1"'}});
        if (method === 'LOCK' && options.failLock) return new Response(JSON.stringify({code:'FILE_LOCK_CONFLICT',outcome:'not-committed'}),{status:options.failLock});
        if (method === 'LOCK') return new Response('<lock/>', {headers:{'Lock-Token':'<opaquelocktoken:test>'}});
        if (method === 'MKCOL') return new Response(null, {status:201});
        if (method === 'PUT' && options.failPut === 'network') throw new TypeError('PRIVATE_CONNECTION_DETAIL');
        if (method === 'PUT' && options.failPut) return new Response(JSON.stringify({code:options.putCode??(options.failPut===423?'FILE_LOCK_CONFLICT':'ECONFLICT'),outcome:'not-committed'}), {status:options.failPut});
        return new Response(null, {status:204,headers:{ETag:'"v2"'}});
    });
    return { calls, fetch:fetch as typeof globalThis.fetch, backend:new WebDavBackend({endpoint,credential:()=> 'PRIVATE_TOKEN',fetch:fetch as typeof globalThis.fetch}) };
}

describe('independent WebDAV file source', () => {
    it('discovers, lists, reads and writes with the original read ETag and a lock', async () => {
        const f = fixture({locks:true}); await f.backend.init();
        expect((await f.backend.files.list('')).entries.map(entry => entry.name)).toEqual(['note.md']);
        const read = await f.backend.files.read('note.md');
        expect(await f.backend.mutations!.replace('note.md', read.data, {kind:'match',revision:read.revision!})).toMatchObject({revision:'"v2"'});
        const put = f.calls.find(call=>call.method==='PUT')!;
        expect(put.headers.get('if-match')).toBe('"v1"'); expect(put.headers.get('if')).toBe('(<opaquelocktoken:test>)');
        expect(f.calls.slice(-3).map(call=>call.method)).toEqual(['LOCK','PUT','UNLOCK']);
        expect(f.calls.every(call=>new URL(call.url).pathname.startsWith('/dav/docs/'))).toBe(true);
        await f.backend.close();
    });
    it('creates conditionally, never overwrites on MOVE and uses MKCOL/DELETE', async () => {
        const f=fixture(); await f.backend.init();
        await f.backend.mutations!.replace('new.md',new Uint8Array(),{kind:'create-only'});
        await f.backend.mutations!.mkdir('folder'); await f.backend.mutations!.rename('new.md','renamed.md'); await f.backend.mutations!.remove('renamed.md');
        expect(f.calls.find(call=>call.method==='PUT')!.headers.get('if-none-match')).toBe('*');
        expect(f.calls.find(call=>call.method==='MOVE')!.headers.get('overwrite')).toBe('F');
        expect(f.calls.find(call=>call.method==='MOVE')!.headers.get('if-match')).toBeNull();
        expect(new Set(f.calls.filter(call=>['PUT','MKCOL','MOVE','DELETE'].includes(call.method)).map(call=>call.headers.get('x-operation-id'))).size).toBe(4);
    });
    it('sends source validators on a Cells conditional export and saves without a lock', async () => {
        const f=fixture({structuralVersions:true}); await f.backend.init();
        await f.backend.mutations!.replace('note.md',new Uint8Array(),{kind:'match',revision:'"v1"'});
        await f.backend.mutations!.rename('note.md','renamed.md');
        await f.backend.mutations!.remove('renamed.md');
        expect(f.calls.filter(call=>['PUT','MOVE','DELETE'].includes(call.method))
            .map(call=>[call.method,call.headers.get('if-match')])).toEqual([['PUT','"v1"'],['MOVE','"v1"'],['DELETE','"v1"']]);
        expect(f.calls.some(call=>call.method==='LOCK'||call.method==='UNLOCK')).toBe(false);
    });
    it('rejects a regular HTTP endpoint that does not advertise DAV', async () => {
        const backend=new WebDavBackend({endpoint,credential:()=> 'fixture',fetch:(async()=>new Response(null)) as typeof fetch});
        await expect(backend.init()).rejects.toMatchObject({code:'ECAPABILITY'});
    });
    it('declares a read-only server without mutation capabilities', async () => {
        const f=fixture({readonly:true}); await f.backend.init(); expect(f.backend.mutations).toBeUndefined();
    });
    it.each([401,403,412,423,507])('preserves a rejected write and specific error at status %s', async status => {
        const f=fixture({failPut:status}); await f.backend.init();
        await expect(f.backend.mutations!.replace('note.md',new Uint8Array(),{kind:'match',revision:'"old"'})).rejects.toMatchObject({outcome:'not-committed',httpStatus:status,operationId:expect.any(String)});
        expect(f.calls.filter(call=>call.method==='PUT')).toHaveLength(1);
    });
    it('retains the original unknown operation and never replays it', async () => {
        const f=fixture({failPut:'network',locks:true}); await f.backend.init();
        const first=await f.backend.mutations!.replace('note.md',new Uint8Array(),{kind:'match',revision:'"v1"'}).catch(error=>error);
        const second=await f.backend.mutations!.replace('note.md',new Uint8Array(),{kind:'match',revision:'"v1"'}).catch(error=>error);
        expect(first.outcome).toBe('unknown'); expect(second.operationId).toBe(first.operationId);
        expect(f.calls.filter(call=>call.method==='PUT')).toHaveLength(1); expect(first.message).not.toContain('PRIVATE');
    });
    it('rejects a missing read version before locking or uploading', async () => {
        const f=fixture({locks:true}); await f.backend.init(); const before=f.calls.length;
        await expect(f.backend.mutations!.replace('note.md',new Uint8Array(),{kind:'match',revision:''})).rejects.toMatchObject({code:'ECONFLICT'});
        expect(f.calls).toHaveLength(before);
    });
    it('checks and opens through the existing driver without native discovery', async () => {
        const f=fixture(), driver=createCellsDriver(()=> 'secret',f.fetch);
        const connection={protocol:'webdav' as const,endpoint,credentialRef:'stored'};
        await driver.checkDraft(connection,'secret'); const owner=await driver.open({...connection,alias:'webdav'});
        expect((await owner.fs.driver.getChildren('/')).map(node=>node.name)).toEqual(['note.md']);
        expect(f.calls.every(call=>!call.url.includes('/v1/'))).toBe(true); await owner.dispose(); await driver.dispose();
    });
});

describe('WebDAV response boundaries', () => {
    it.each(['../escape','%2e%2e/escape','/outside/file','https://elsewhere/dav/docs/file','/dav/docs/a%2fb','/dav/docs/a%5cb'])('rejects escaping href %s', href => {
        expect(()=>hrefPath(davRoot(endpoint),href)).toThrow();
    });
    it.each(['../escape','/absolute','a/../b','a\\b','C:/file'])('rejects invalid input %s', path => {
        expect(()=>davUrl(davRoot(endpoint),path)).toThrow();
    });
    it('handles namespace aliases and escaped names, rejects DTD and malformed XML', () => {
        expect(multistatus(xml(props('/dav/docs/a&amp;b.md')))[0].href).toBe('/dav/docs/a&b.md');
        expect(()=>multistatus('<!DOCTYPE a [<!ENTITY x "bad">]>'+xml())).toThrow();
        expect(()=>multistatus('<D:multistatus>')).toThrow();
    });
});

it('protects the configured collection root from mutations without contacting the server', async () => {
    const f=fixture();await f.backend.init();const before=f.calls.length;
    await expect(f.backend.mutations!.remove('')).rejects.toMatchObject({code:'EACCES'});
    await expect(f.backend.mutations!.rename('','other')).rejects.toMatchObject({code:'EACCES'});
    await expect(f.backend.mutations!.rename('file','')).rejects.toMatchObject({code:'EACCES'});
    await expect(f.backend.mutations!.replace('',new Uint8Array(),{kind:'create-only'})).rejects.toMatchObject({code:'EACCES'});
    expect(f.calls).toHaveLength(before);
});


it('retains a lock conflict without attempting PUT and distinguishes an expired lock during upload', async () => {
    const conflict=fixture({locks:true,failLock:423});await conflict.backend.init();
    await expect(conflict.backend.mutations!.replace('note.md',new Uint8Array(),{kind:'match',revision:'"v1"'})).rejects.toMatchObject({code:'EBUSY',remoteCode:'FILE_LOCK_CONFLICT',outcome:'not-committed'});
    expect(conflict.calls.some(call=>call.method==='PUT')).toBe(false);
    const expired=fixture({locks:true,failPut:412,putCode:'DAV_LOCK_TOKEN_INVALID'});await expired.backend.init();
    await expect(expired.backend.mutations!.replace('note.md',new Uint8Array(),{kind:'match',revision:'"v1"'})).rejects.toMatchObject({code:'ECONFLICT',remoteCode:'DAV_LOCK_TOKEN_INVALID'});
    expect(expired.calls.at(-1)?.method).toBe('UNLOCK');
});

it('classifies an upload timeout as unknown and retains the request identity', async () => {
    const f=fixture();
    const fetch:typeof globalThis.fetch=async(input,init)=>{
        if(init?.method!=='PUT')return f.fetch(input,init);
        return new Promise((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(new Error('private network detail')),{once:true}));
    };
    const backend=new WebDavBackend({endpoint,credential:()=> 'private',fetch});await backend.init();
    await expect(backend.mutations!.replace('note.md',new Uint8Array(),{kind:'match',revision:'"v1"'},{timeoutMs:5})).rejects.toMatchObject({code:'ETIMEDOUT',outcome:'unknown',remoteCode:'DAV_REQUEST_TIMEOUT',operationId:expect.any(String)});
    await backend.close();
});
