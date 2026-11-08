import {expect,it,vi} from 'vitest';
import {createCellsDriver} from '../src/provider';
const connection={endpoint:'https://cells.test/node',credentialRef:'key'};
const status={version:1,scope:'system',sampledAt:1,cpu:{cores:2,usagePercent:12.5,loadAverage:[.1,.2,.3]},memory:{totalBytes:1024,availableBytes:512},exports:[{alias:'docs',totalBytes:2048,availableBytes:1024}],harness:{activeSessions:2,loadedRuntimes:1}};
it('reads bounded node statistics with credentials and no capability discovery',async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>(async()=>Response.json(status)),driver=createCellsDriver(()=> 'private-token',fetch);
    try{expect(await driver.nodeStatus(connection)).toEqual(status);expect(fetch).toHaveBeenCalledOnce();
        expect(String(fetch.mock.calls[0][0])).toBe('https://cells.test/node/v1/node/status');
        expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer private-token');}
    finally{await driver.dispose();}
});
it('classifies old servers separately from authentication failure',async()=>{
    for(const [http,code] of [[404,'ECAPABILITY'],[401,'EACCES']] as const){
        const driver=createCellsDriver(()=> 'secret',vi.fn(async()=>Response.json({code:'EACCES'},{status:http})));
        try{await expect(driver.nodeStatus(connection)).rejects.toMatchObject({code});}finally{await driver.dispose();}
    }
});
it('rejects invalid measurements instead of showing fabricated zero values',async()=>{
    const driver=createCellsDriver(()=> 'secret',vi.fn(async()=>Response.json({...status,memory:{totalBytes:1,availableBytes:2}})));
    try{await expect(driver.nodeStatus(connection)).rejects.toMatchObject({code:'EIO'});}finally{await driver.dispose();}
});
it('aborts pending statistics reads when the driver is disposed',async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>(async(_input,init)=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})));
    const driver=createCellsDriver(()=> 'secret',fetch),read=expect(driver.nodeStatus(connection)).rejects.toThrow();
    await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce());await driver.dispose();await read;
});
