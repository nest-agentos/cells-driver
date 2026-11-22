import {FSError} from '@nestos/vfs-core';

const supported = ['accept', 'acceptForSession', 'decline', 'cancel', 'allow', 'approve', 'deny', 'reject'];
/** Unknown alternatives do not invalidate independently usable native decisions. */
export function harnessApprovalDecisions(offered: unknown): string[] {
    if (!Array.isArray(offered)) return [];
    return [...new Set(offered.filter((value): value is string => typeof value === 'string' && supported.includes(value)))];
}
export function resolveHarnessApprovalDecision(offered: unknown, selection: unknown): string {
    if ((selection === 'allowSiteRead' || selection === 'allowSiteReadWrite')
        && Array.isArray(offered) && offered.includes(selection)) return selection;
    if (typeof selection !== 'string' || !harnessApprovalDecisions(offered).includes(selection))
        throw new FSError('EINVAL', 'Approval decision was not offered or is unsupported');
    return selection;
}
