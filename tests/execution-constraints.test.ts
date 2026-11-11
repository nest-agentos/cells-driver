import {expect,it} from 'vitest';
import {harnessExecutionConstraints} from '../src';
const idle=()=>({writerLock:{status:'not-held'},observation:{execution:'idle',connection:'online',stale:false,receiptUnknown:false,owned:true}}) as any;
it('requires positive native evidence and preserves queues, drafts and unknown controls',()=>{
 expect(harnessExecutionConstraints({})).toMatchObject({unknown:true});
 for(const field of [{pending:true},{draft:'Continue'},{instructionQueue:{items:[{}]}},{controls:[{receipt:'unknown'}]}])expect(harnessExecutionConstraints({...idle(),...field}).busy).toBe(true);
 expect(harnessExecutionConstraints({...idle(),observation:{...idle().observation,stale:true}}).unknown).toBe(true);
});
it('allows retained owned-idle resume while preserving cleanup ownership and uncertain receipts',()=>{
 const state={...idle(),writerLock:{status:'held'}};
 expect(harnessExecutionConstraints(state)).toMatchObject({busy:true,idleOwner:false});
 expect(harnessExecutionConstraints(state,true)).toMatchObject({busy:false,unknown:false,idleOwner:true});
 expect(harnessExecutionConstraints({...state,observation:{...state.observation,receiptUnknown:true}},true)).toMatchObject({busy:true,unknown:true,idleOwner:false});
});
