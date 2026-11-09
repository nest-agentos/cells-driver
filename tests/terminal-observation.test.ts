import {expect, it, vi} from 'vitest';
import {HarnessConversation} from '../src/harness/conversation';
import type {HarnessClient, HarnessProfile, HarnessSession} from '../src/harness/contracts';
import type {HarnessConversationJournal,HarnessRecovery} from '../src/harness/conversation-journal';

async function fixture() {
    const profile: HarnessProfile = {id: 'codex', kind: 'codex', workspaces: [{id: 'project'}], capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true}};
    const session: HarnessSession = {id: 'native', title: 'Native', cwd: '/project', status: 'active', activeTurnId: 'old-turn', updatedAt: 1, resumable: true, owned: true};
    let record: HarnessRecovery = {sessionId: 'native', instructionQueue: {revision: 2, paused: false, receipts: [{id: 'first', input: 'a'.repeat(64), turnId: 'old-turn'}],
        items: [{id: 'first', text: 'Original', attachments: [], createdAt: Date.now(), state: 'dispatching', receipt: {turnId: 'old-turn'}}]}};
    const client: HarnessClient = {profiles: vi.fn(async () => ({epoch: 'epoch', profiles: [profile]})), read: vi.fn(async () => ({session, turns: []})),
        inspect: vi.fn(async () => ({session: {...session, status: 'idle', activeTurnId: null, lastTurnId: 'old-turn'} })),
        eventSnapshot: vi.fn(async () => ({epoch: 'events', cursor: 0, gap: false, events: [], requests: []})), subscribe: () => () => {},
        list: vi.fn(), create: vi.fn(), resume: vi.fn(), turn: vi.fn(), interrupt: vi.fn(), respond: vi.fn(), operation: vi.fn(), close: vi.fn()};
    const save = vi.fn(async (next: HarnessRecovery) => {record = structuredClone(next);});
    const journal:HarnessConversationJournal={epoch:'epoch',load:async()=>record,save};
    const view = new HarnessConversation(client, profile, 'project', 'native', true, journal);
    await view.read(); return {client, view, session, profile, save, journal, saved: () => record};
}

it('settles an admitted turn from exact inspection evidence when its completion event was missed', async () => {
    const f = await fixture();
    vi.mocked(f.client.inspect!).mockResolvedValue({session: {...f.session, status: 'idle', activeTurnId: null, lastTurnId: 'old-turn', lastTurnResult: 'completed'}});
    try {await f.view.refresh(); expect(f.view.snapshot().instructionQueue!.items).toEqual([]); expect(f.client.turn).not.toHaveBeenCalled();}
    finally {await f.view.close();}
});

it.each([true, false])('checks native history when an idle queue lacks terminal evidence (confirmed: %s)', async confirmed => {
    const f = await fixture();
    vi.mocked(f.client.read).mockResolvedValue({session: {...f.session, status: 'idle', activeTurnId: null},
        turns: confirmed ? [{id: 'old-turn', status: 'completed', items: []}] : []});
    try {
        await f.view.refresh(); expect(f.client.read).toHaveBeenCalledTimes(2);
        expect(f.view.snapshot().instructionQueue!.items).toHaveLength(confirmed ? 0 : 1);
        if (!confirmed) {expect(f.view.snapshot().instructionQueue!.reason).toBe('terminal-unconfirmed');
            await f.view.refresh(); expect(f.client.read).toHaveBeenCalledTimes(2);}
        expect(f.client.turn).not.toHaveBeenCalled();
    } finally {await f.view.close();}
});

it('recovers an idle queued turn from native history even without an inspection capability', async () => {
    const f = await fixture(); f.client.inspect = undefined;
    vi.mocked(f.client.eventSnapshot).mockResolvedValue({epoch: 'events', cursor: 1, gap: false, requests: [],
        events: [{seq: 1, message: {method: 'thread/status/changed', params: {threadId: 'native', status: {type: 'idle'}}}}]});
    vi.mocked(f.client.read).mockResolvedValue({session: {...f.session, status: 'idle', activeTurnId: null}, turns: [{id: 'old-turn', status: 'completed', items: []}]});
    try {await f.view.refresh(); expect(f.view.snapshot().instructionQueue!.items).toEqual([]); expect(f.client.turn).not.toHaveBeenCalled();}
    finally {await f.view.close();}
});

it('does not unblock the queue using another turn completion', async () => {
    const f = await fixture(), another = {...f.session, status: 'idle', activeTurnId: null, lastTurnId: 'another-turn', lastTurnResult: 'completed' as const};
    vi.mocked(f.client.inspect!).mockResolvedValue({session: another});
    vi.mocked(f.client.read).mockResolvedValue({session: another, turns: [{id: 'another-turn', status: 'completed', items: []}]});
    try {
        await f.view.refresh(); expect(f.view.snapshot().instructionQueue!.items[0].id).toBe('first');
        expect(f.view.snapshot().instructionQueue!.reason).toBe('terminal-unconfirmed'); expect(f.client.turn).not.toHaveBeenCalled();
    } finally {await f.view.close();}
});

it.each(['completed', 'failed', 'interrupted', 'another-turn', 'missing'])('recovers history despite failed events without replaying input (%s)', async status => {
    const f = await fixture();
    const eventError = Object.assign(new Error('private transport details'), {code: 'EIO'});
    vi.mocked(f.client.eventSnapshot).mockRejectedValue(eventError);
    vi.mocked(f.client.read).mockResolvedValue({session: {...f.session, status: 'idle', activeTurnId: null},
        turns: status === 'missing' ? [] : [{id: status === 'another-turn' ? 'other' : 'old-turn', status: status === 'another-turn' ? 'completed' : status, items: []}]});
    try {
        await f.view.refresh();
        const confirmed = !['another-turn', 'missing'].includes(status);
        expect(f.view.snapshot().instructionQueue!.items).toHaveLength(confirmed ? 0 : 1);
        expect(f.saved().instructionQueue!.items).toHaveLength(confirmed ? 0 : 1);
        expect(f.view.snapshot().observation.refreshError).toEqual({stage: 'events', code: 'EIO'});
        expect(f.view.snapshot().canSend).toBe(false);
        expect(f.client.read).toHaveBeenCalledTimes(2);
        await f.view.refresh();
        expect(f.client.read).toHaveBeenCalledTimes(2);
        expect(f.client.turn).not.toHaveBeenCalled();
        expect(f.client.resume).not.toHaveBeenCalled();
    } finally {await f.view.close();}
});

it('keeps the queue and event failure when fallback history is unavailable, then retries after the interval', async () => {
    const f = await fixture(), clock = vi.spyOn(Date, 'now'), started = Date.now();
    clock.mockReturnValue(started);
    vi.mocked(f.client.eventSnapshot).mockRejectedValue(Object.assign(new Error('unreachable'), {code: 'ECONNREFUSED'}));
    vi.mocked(f.client.read).mockRejectedValueOnce(Object.assign(new Error('private history details'), {code: 'EACCES'}));
    try {
        await f.view.refresh();
        expect(f.view.snapshot().instructionQueue!.items).toHaveLength(1);
        expect(f.view.snapshot().observation.refreshError).toEqual({stage: 'events', code: 'ECONNREFUSED'});
        expect(f.view.snapshot().observation.connection).toBe('offline');
        await f.view.refresh(); expect(f.client.read).toHaveBeenCalledTimes(2);
        clock.mockReturnValue(started + 15_001);
        vi.mocked(f.client.read).mockResolvedValue({session: {...f.session, status: 'idle', activeTurnId: null}, turns: [{id: 'old-turn', status: 'completed', items: []}]});
        await f.view.refresh();
        expect(f.client.read).toHaveBeenCalledTimes(3);
        expect(f.view.snapshot().instructionQueue!.items).toEqual([]);
        expect(f.client.turn).not.toHaveBeenCalled();
    } finally {clock.mockRestore(); await f.view.close();}
});

const recoveryEvidence = {state: 'detached' as const, checkedAt: 100, runtimeId: 'a'.repeat(32), processId: 10, childPid: 11, runtimeStartedAt: 50};
function detachedSession(session: HarnessSession): HarnessSession {
    return {...session, status: 'notLoaded', activeTurnId: null, owned: false, loaded: false,
        writerLock: {status: 'not-held', checkedAt: 100}, executionRecovery: recoveryEvidence};
}

it('delegates recovery to Cells and consumes its persisted queue without a native resend',async()=>{
    const f=await fixture();
    const recover=vi.fn(async()=>{const next=structuredClone(f.saved());next.instructionQueue!.revision++;next.instructionQueue!.items=[];next.instructionQueue!.paused=true;await f.save(next);});
    f.journal.recoverSession=recover;
    try{
        await f.view.editInstructionQueue({action:'recover',id:'first',expectedRevision:2});
        expect(recover).toHaveBeenCalledWith(expect.objectContaining({sessionId:'native',instructionId:'first',expectedRevision:2,operationId:expect.any(String)}));
        expect(f.view.snapshot().instructionQueue).toMatchObject({revision:3,paused:true,items:[]});expect(f.client.turn).not.toHaveBeenCalled();expect(f.client.resume).not.toHaveBeenCalled();
    }finally{await f.view.close();}
});
it('does not run local recovery rules when no Cells recovery authority is bound',async()=>{
    const f=await fixture();try{
        await expect(f.view.editInstructionQueue({action:'recover',id:'first',expectedRevision:2})).rejects.toMatchObject({code:'ECAPABILITY'});
        expect(f.saved().instructionQueue!.items).toHaveLength(1);expect(f.client.turn).not.toHaveBeenCalled();
    }finally{await f.view.close();}
});
it.each(['ECONFLICT','EBUSY','EIO'])('retains the queue and propagates the Cells rejection (%s)',async code=>{
    const f=await fixture();f.journal.recoverSession=vi.fn(async()=>{throw Object.assign(new Error('Node recovery rejected'),{code,outcome:code==='EIO'?'unknown':'not-committed'});});
    try{await expect(f.view.editInstructionQueue({action:'recover',id:'first',expectedRevision:2})).rejects.toMatchObject({code});
        expect(f.saved().instructionQueue!.items).toHaveLength(1);expect(f.client.turn).not.toHaveBeenCalled();
    }finally{await f.view.close();}
});

it('offers recovery after the observation timeout without treating the timeout as completion', async () => {
    const f = await fixture(); f.profile.capabilities.executionRecovery = true;
    const clock = vi.spyOn(Date, 'now'), createdAt = f.saved().instructionQueue!.items[0].createdAt;
    try {
        clock.mockReturnValue(createdAt + 59_999);
        expect(f.view.snapshot().instructionQueue!.recovery).toBeUndefined();
        clock.mockReturnValue(createdAt + 60_000);
        expect(f.view.snapshot().instructionQueue!.recovery).toEqual({id: 'first'});
        expect(f.saved().instructionQueue!.items).toHaveLength(1);
        expect(f.saved().instructionQueue!.recoveries).toBeUndefined();
        expect(f.client.turn).not.toHaveBeenCalled();
    } finally {clock.mockRestore(); await f.view.close();}
});

it.each(['completed', 'interrupted'])('settles a terminal-only rollout row after reopening (%s)', async status => {
    const f = await fixture(); await f.view.close();
    vi.mocked(f.client.read).mockResolvedValue({session: detachedSession(f.session),
        turns: [{items: []}, {id: 'old-turn', status, items: []}]});
    const reopened = new HarnessConversation(f.client, f.profile, 'project', 'native', true,
        {epoch: 'new-epoch', load: async () => structuredClone(f.saved()), save: f.save});
    try {
        await reopened.read(); await reopened.refresh();
        expect(f.saved().instructionQueue!.items).toEqual([]);
        expect(f.saved().instructionQueue!.recoveries).toBeUndefined();
        expect(f.client.turn).not.toHaveBeenCalled(); expect(f.client.resume).not.toHaveBeenCalled();
    } finally {await reopened.close();}
});

it('immediately projects a detached turn as requiring recovery without changing admission or replaying', async () => {
    const f = await fixture(); f.profile.capabilities.executionRecovery = true;
    const now = Date.now(), session = detachedSession(f.session);
    session.executionRecovery = {...recoveryEvidence, checkedAt: now}; session.writerLock = {status: 'not-held', checkedAt: now};
    vi.mocked(f.client.read).mockResolvedValue({session, turns: []});
    vi.mocked(f.client.inspect!).mockResolvedValue({session});
    await f.view.enqueue('Later instruction', [], undefined, 'later');
    try {
        await f.view.read();
        const before = structuredClone(f.saved());
        expect(f.view.snapshot().instructionQueue).toMatchObject({reason: 'execution-detached', recovery: {id: 'first', required: true},
            items: [{id: 'first', state: 'dispatching'}, {id: 'later', state: 'pending'}]});
        expect(f.saved()).toEqual(before); expect(f.client.turn).not.toHaveBeenCalled();
        const reopened = new HarnessConversation(f.client, f.profile, 'project', 'native', true,
            {epoch: 'new-epoch', load: async () => structuredClone(f.saved()), save: f.save});
        try {await reopened.read(); expect(reopened.snapshot().instructionQueue!.recovery).toEqual({id: 'first', required: true});}
        finally {await reopened.close();}
    } finally {await f.view.close();}
});

it.each(['held', 'stale', 'missing'])('does not report positive detachment with %s evidence', async blocked => {
    const f = await fixture(); f.profile.capabilities.executionRecovery = true;
    const now = Date.now(), session = detachedSession(f.session), checkedAt = blocked === 'stale' ? now - 30_001 : now;
    session.executionRecovery = {...recoveryEvidence, checkedAt}; session.writerLock = {status: blocked === 'held' ? 'held' : 'not-held', checkedAt};
    if (blocked === 'missing') delete session.executionRecovery;
    vi.mocked(f.client.read).mockResolvedValue({session, turns: []});
    try {await f.view.read(); expect(f.view.snapshot().instructionQueue!.reason).toBe('terminal-unconfirmed');
        expect(f.view.snapshot().instructionQueue!.recovery).toBeUndefined(); expect(f.client.turn).not.toHaveBeenCalled();}
    finally {await f.view.close();}
});

it('turns prolonged idle waiting into an actionable recovery state without assuming completion', async () => {
    const f = await fixture(); f.profile.capabilities.executionRecovery = true;
    const clock = vi.spyOn(Date, 'now'), started = Date.now();
    vi.mocked(f.client.read).mockResolvedValue({session: {...f.session, status: 'idle', activeTurnId: null}, turns: []});
    try {
        await f.view.read(); clock.mockReturnValue(started + 60_001);
        expect(f.view.snapshot().instructionQueue).toMatchObject({reason: 'recovery-required', recovery: {id: 'first', required: true}});
        expect(f.saved().instructionQueue!.items).toHaveLength(1); expect(f.client.turn).not.toHaveBeenCalled();
    } finally {clock.mockRestore(); await f.view.close();}
});

function restartedSession(session: HarnessSession): HarnessSession {
    const checkedAt = Date.now();
    return {...detachedSession(session), writerLock: {status: 'not-held', checkedAt}, executionRecovery: {
        ...recoveryEvidence, checkedAt, interruptedTurns: [{turnId: 'old-turn', requestId: 'first', previousEpoch: 'previous-node', recoveredAt: checkedAt - 1, reason: 'CELLS_RESTARTED'}]}};
}

it('does not decide automatic recovery in the NestOS driver even when restart proof is present',async()=>{
    const f=await fixture();f.profile.capabilities.executionRecovery=true;
    const session=restartedSession(f.session);vi.mocked(f.client.read).mockResolvedValue({session,turns:[]});vi.mocked(f.client.inspect!).mockResolvedValue({session});
    try{await f.view.read();expect(f.saved().instructionQueue!.items).toHaveLength(1);expect(f.saved().instructionQueue!.recoveries).toBeUndefined();expect(f.client.turn).not.toHaveBeenCalled();}
    finally{await f.view.close();}
});
