import {FSError} from '@nestos/vfs-core';
import type {HarnessExecutionRecovery, HarnessSession} from './contracts';
import type {HarnessObservation} from './state';

export function validateExecutionRecovery(value: unknown): HarnessExecutionRecovery | undefined {
    if (value === undefined) return;
    const row = value as HarnessExecutionRecovery;
    if (!row || !['running', 'detached', 'unknown'].includes(row.state)
        || typeof row.runtimeId !== 'string' || !/^[a-f0-9]{32}$/.test(row.runtimeId)
        || [row.checkedAt, row.processId, row.childPid, row.runtimeStartedAt].some(n => !Number.isSafeInteger(n) || n <= 0))
        throw new FSError('EIO', 'Invalid execution recovery observation');
    const interruptedTurns = validateInterruptedTurns(row.interruptedTurns, row.checkedAt);
    return {...(interruptedTurns ? {interruptedTurns} : {}), state: row.state, runtimeId: row.runtimeId, checkedAt: row.checkedAt,
        processId: row.processId, childPid: row.childPid, runtimeStartedAt: row.runtimeStartedAt};
}

/** The node must positively observe a detached runtime; absence of a PID is insufficient. */
export function detachedExecution(session: HarnessSession | undefined): HarnessExecutionRecovery | undefined {
    const evidence = session?.executionRecovery;
    if (evidence?.state !== 'detached' || session?.owned !== false || session.loaded !== false
        || session.status !== 'notLoaded' || session.activeTurnId || session.writerLock?.status !== 'not-held'
        || session.writerLock.checkedAt !== evidence.checkedAt) return;
    return validateExecutionRecovery(evidence);
}

/** Recovery hints require fresh positive evidence, not an idle or missing runtime alone. */
export function freshDetachedExecution(session: HarnessSession | undefined, observation: HarnessObservation): boolean {
    const evidence = detachedExecution(session);
    if (!evidence) return false;
    const age = Date.now() - evidence.checkedAt;
    return age >= 0 && age < 30_000 && observation.connection === 'online'
        && !observation.stale && !observation.receiptUnknown && observation.execution === 'idle';
}

function validateInterruptedTurns(value: HarnessExecutionRecovery['interruptedTurns'], checkedAt: number) {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > 64 || value.some(row => !row || row.reason !== 'CELLS_RESTARTED'
        || typeof row.turnId !== 'string' || !row.turnId.length || row.turnId.length > 1024
        || ![row.requestId, row.previousEpoch].every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id))
        || !Number.isSafeInteger(row.recoveredAt) || row.recoveredAt <= 0 || row.recoveredAt > checkedAt))
        throw new FSError('EIO', 'Invalid persisted execution recovery');
    return value.map(({turnId, requestId, previousEpoch, recoveredAt, reason}) => ({turnId, requestId, previousEpoch, recoveredAt, reason}));
}
