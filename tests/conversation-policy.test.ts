import {expect, it} from 'vitest';
import {conversationPolicy, type ConversationPolicyFacts} from '../src/harness/conversation-policy';
import {harnessObservation} from '../src/harness/state';

function facts(): ConversationPolicyFacts {
    const session = {id: 'session', title: 'Native', cwd: '/p', status: 'idle', updatedAt: 1, owned: true, resumable: true};
    return {session, observation: harnessObservation(session), capabilities: {history: true, create: true, resume: true,
        interrupt: true, interactions: true}, client: {}, loaded: true, writable: true, closed: false, deleted: false,
        busy: false, pending: false, navigating: false, forking: false, durable: true, controlBlocked: false,
        resultBlocked: false, commandRunning: false, queueLength: 0, hasMessages: false, turnCompleted: false,
        canInterrupt: false, requests: [], respondingIds: []};
}

it.each(['running', 'waiting-approval', 'waiting-input'] as const)('allows durable admission while execution is %s', execution => {
    const state = facts(); state.observation.execution = execution;
    expect(conversationPolicy(state)).toMatchObject({canQueue: true, canSend: false});
});
it.each(['busy', 'pending', 'controlBlocked', 'resultBlocked'] as const)('separates admission from the %s dispatch barrier', key => {
    const state = facts(); state[key] = true; state.observation.receiptUnknown = true;
    expect(conversationPolicy(state)).toMatchObject({canQueue: true, canSend: false, canSteer: false});
});
it.each(['closed', 'deleted', 'navigating', 'forking'] as const)('blocks admission during %s lifecycle restrictions', key => {
    const state = facts(); state[key] = true;
    expect(conversationPolicy(state).canQueue).toBe(false);
});
it('requires durable writable admission without manufacturing execution readiness', () => {
    for (const key of ['loaded', 'writable', 'durable'] as const) {
        const state = facts(); state[key] = false; expect(conversationPolicy(state).canQueue).toBe(false);
    }
    const state = facts(); state.observation.stale = true;
    expect(conversationPolicy(state)).toMatchObject({canQueue: true, canSend: false});
    state.session!.archived = true; expect(conversationPolicy(state).canQueue).toBe(false);
});
it('restores dispatch by changing facts without another lifecycle transition', () => {
    const state = facts(); state.busy = true;
    expect(conversationPolicy(state).canSend).toBe(false);
    state.busy = false; expect(conversationPolicy(state).canSend).toBe(true);
});
