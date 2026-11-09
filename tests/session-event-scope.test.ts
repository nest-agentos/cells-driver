import {expect,it,vi} from 'vitest';
import {CellsHarnessClient} from '../src/harness/client';
it('keeps each native session on its own event feed and reuses the same subscription for snapshots',async()=>{
 const subscribe=vi.fn((_plugin:string,args:Record<string,unknown>,listener:any)=>{listener.next({epoch:String(args.sessionId),cursor:0,events:[],requests:[],gap:false});return vi.fn();});
 const client=new CellsHarnessClient({subscribe,call:vi.fn(),close:vi.fn()},{projectId:'main',revision:1});
 const stopOne=client.subscribe('codex',vi.fn(),'one'),stopTwo=client.subscribe('codex',vi.fn(),'two');
 expect((await client.eventSnapshot('codex',undefined,{sessionId:'one'})).epoch).toBe('one');
 expect((await client.eventSnapshot('codex',undefined,{sessionId:'two'})).epoch).toBe('two');
 expect(subscribe).toHaveBeenCalledTimes(2);expect(subscribe.mock.calls.map(row=>row[1])).toEqual([{projectId:'main',revision:1,profileId:'codex',sessionId:'one'},{projectId:'main',revision:1,profileId:'codex',sessionId:'two'}]);
 stopOne();stopTwo();await client.close();
});
