import type {HarnessConversationSnapshot} from './conversation-snapshot';
export type HarnessExecutionEvidence=Partial<Pick<HarnessConversationSnapshot,'observation'|'writerLock'|'archived'|'active'|'pending'|'requests'|'instructionQueue'|'draft'|'controls'>>;
/** Shared native facts for resource ownership and retained-session admission; never start or resume work. */
export function harnessExecutionConstraints(state:HarnessExecutionEvidence,resumeOwned=false) {
    const observed=state.observation;
    const unknown=state.writerLock?.status==='unknown'||!observed||observed.stale||observed.connection!=='online'||observed.receiptUnknown===true||observed.execution==='unknown';
    const idleOwner=!!((state.archived||resumeOwned&&observed?.owned===true)&&observed?.execution==='idle'&&!unknown);
    const busy=!!(state.writerLock?.status==='held'&&!idleOwner||state.active||state.pending||state.requests?.length||state.instructionQueue?.items.length||state.draft?.trim()
        ||state.controls?.some(control=>control.receipt==='unknown'||control.receipt==='accepted'&&control.effect==='unconfirmed'));
    return {busy,unknown:!!unknown,idleOwner};
}
