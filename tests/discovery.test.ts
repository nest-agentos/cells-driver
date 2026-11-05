import {expect,it,vi} from 'vitest';
import {createCellsDriver} from '../src/provider';
const descriptor={version:1,api:{version:1},httpEndpoint:'./',fileProtocol:'fs-agent-http-v1',serverId:'node',harness:true};
it('discovers fixed Cells capabilities at the configured node root with no MCP negotiation',async()=>{
    const fetch=vi.fn(async()=>Response.json({node:descriptor})),driver=createCellsDriver(()=> 'secret',fetch);
    try {expect((await driver.discover({endpoint:'https://cells.test/node',credentialRef:'key'})).httpEndpoint).toBe('https://cells.test/node');
        expect(fetch).toHaveBeenCalledOnce();expect(String(fetch.mock.calls[0][0])).toBe('https://cells.test/node/v1/capabilities');
        expect(fetch.mock.calls[0][1]?.body).toBeUndefined();
    }finally{await driver.dispose();}
});
it.each([{...descriptor,api:undefined},{...descriptor,api:{version:2}},{...descriptor,fileProtocol:'unknown'},{...descriptor,httpEndpoint:'https://foreign.test'}])('rejects an invalid descriptor without a fallback transport',async node=>{
    const fetch=vi.fn(async()=>Response.json({node})),driver=createCellsDriver(()=> 'secret',fetch);
    try {await expect(driver.discover({endpoint:'https://cells.test',credentialRef:'key'})).rejects.toThrow();expect(fetch).toHaveBeenCalledOnce();}
    finally{await driver.dispose();}
});
it('preserves authentication and network failures without rediscovery or another endpoint',async()=>{
    for(const fail of [async()=>Response.json({code:'EACCES'},{status:401}),async()=>{throw Object.assign(new Error('offline'),{code:'ECONNREFUSED'});}]){
        const fetch=vi.fn(fail),driver=createCellsDriver(()=> 'secret',fetch);
        try{await expect(driver.discover({endpoint:'https://cells.test',credentialRef:'key'})).rejects.toThrow();expect(fetch).toHaveBeenCalledOnce();}finally{await driver.dispose();}
    }
});

it('aborts pending discovery transport when the driver closes',async()=>{
    let aborted=false;
    const fetch=vi.fn<typeof globalThis.fetch>(async(_url,init)=>new Promise<Response>((_resolve,reject)=>{
        const stop=()=>{aborted=true;reject(new DOMException('Aborted','AbortError'));};
        if(init?.signal?.aborted)stop();else init?.signal?.addEventListener('abort',stop,{once:true});
    }));
    const driver=createCellsDriver(()=>'secret',fetch);
    const rejected=expect(driver.discover({endpoint:'https://cells.test',credentialRef:'key'})).rejects.toThrow();
    await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce());
    await driver.dispose();await rejected;expect(aborted).toBe(true);
});
