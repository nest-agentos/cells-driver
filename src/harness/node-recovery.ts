import {FSError} from '@nestos/vfs-core';
import {validateSession} from './validation';
import type {HarnessSession} from './contracts';
import type {HarnessInstruction,HarnessInstructionQueue,HarnessQueueEdit} from './instruction-queue';
import {projectInstructionQueue,validateInstructionQueue} from './instruction-queue';
export interface HarnessNodeRecoveryRequest {
    namespace: string; profileId: string; sessionId: string; action: 'inspect' | 'recover';
    operationId?: string; instructionId?: string; expectedRevision?: number;
}
export interface HarnessNodeQueueRequest extends Omit<HarnessNodeRecoveryRequest,'action'> {
    action:'read'|'enqueue'|'edit'; item?:HarnessInstruction;
    edit?:HarnessQueueEdit & {commandBinding?:{id?:string;revision?:string}}; input?:string;
}
export type HarnessNodeQueueCommand=Pick<HarnessNodeQueueRequest,'action'|'item'|'edit'|'input'>;
export interface HarnessNodeRecoveryResult {
    session: HarnessSession; queue?: HarnessInstructionQueue; operationId?: string;
    outcome?: 'recovered' | 'no-longer-blocked'; duplicate?: boolean;
}
export function validateNodeRecovery(value: unknown, request: HarnessNodeRecoveryRequest): HarnessNodeRecoveryResult {
    const result=value as HarnessNodeRecoveryResult;
    if (!result || result.session?.id!==request.sessionId) throw new FSError('EIO','Invalid Cells recovery session');
    const session=validateSession(result.session);
    if (request.action==='recover' && (result.operationId!==request.operationId || !['recovered','no-longer-blocked'].includes(result.outcome ?? '') || typeof result.duplicate!=='boolean'))
        throw new FSError('EIO','Invalid Cells recovery receipt');
    if (result.queue) validateNodeQueue(result.queue);
    return {...result,session};
}
export function validateNodeQueue(queue: HarnessInstructionQueue): void {validateInstructionQueue(queue);}
export function projectNodeQueue(queue: HarnessInstructionQueue | undefined) {
    if (!queue) return undefined;
    validateInstructionQueue(queue);return projectInstructionQueue(queue);
}
