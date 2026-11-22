import type {HarnessEvent} from './contracts';
import {harnessApprovalDecisions} from './approval';

export interface HarnessQuestion {
    id: string; question: string; header?: string; multiSelect?: boolean; isSecret?: boolean; isOther?: boolean;
    options?: Array<{label: string; description?: string}>;
}
export interface HarnessApprovalContext {
    kind:'command'|'file-change';reason?:string;command?:string;path?:string;cwd?:string;toolName?:string;
}
export interface HarnessRequest {
    approval?:HarnessApprovalContext;
    id: string | number; kind: 'approval' | 'input' | 'unsupported'; detail: string; title?: string;
    interactionScope?: string;
    questions?: HarnessQuestion[]; decisions?: string[]; unsupportedDecisionCount?: number; responding?: boolean;
}
function codexMcpToolApproval(request: HarnessEvent['message']): HarnessRequest | undefined {
    const params = request.params;
    const meta = record(params?._meta), schema = record(params?.requestedSchema);
    const properties = record(schema?.properties);
    if (request.id === undefined || request.method !== 'mcpServer/elicitation/request'
        || params?.mode !== 'form' || meta?.codex_approval_kind !== 'mcp_tool_call'
        || schema?.type !== 'object' || !properties || Object.keys(properties).length
        || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length))) return;
    const tool = meta.tool_name, server = params.serverName, message = params.message;
    if (typeof tool !== 'string' || !tool || typeof server !== 'string' || !server || typeof message !== 'string') return;
    const site = record(params.cellsSiteApproval);
    const origin = typeof site?.origin === 'string' && site.origin.startsWith('https://') ? site.origin : undefined;
    const display = meta.tool_params_display;
    const detail = typeof display === 'string' ? display : display ? JSON.stringify(display, null, 2) : '';
    return {id: request.id, kind: 'approval', title: origin ? `${origin} · ${tool}` : `${server} / ${tool}`,
        detail: `${message}\n${detail}`.trim().slice(0, 8000), decisions: origin ? ['decline', 'accept', 'allowSiteRead', 'allowSiteReadWrite'] : ['accept', 'decline']};
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function nativeRequest(request: HarnessEvent['message'], eventEpoch?: string): HarnessRequest[] {
    if (request.id === undefined) return [];
    const params = request.params ?? {};
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const scope = eventEpoch || turnId ? {interactionScope: JSON.stringify([eventEpoch, turnId])} : {};
    const mcpApproval = codexMcpToolApproval(request);
    if (mcpApproval) return [{...mcpApproval, ...scope}];
    let kind: HarnessRequest['kind'] = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)
        ? 'approval' : request.method === 'item/tool/requestUserInput' ? 'input' : 'unsupported';
    const questions = Array.isArray(params.questions) ? params.questions.map(question) : undefined;
    if (kind === 'input' && (!questions?.length || questions.some(q => !q) || new Set(questions.map(q => q?.id)).size !== questions.length)) kind = 'unsupported';
    const offered = params.decisions ?? params.availableDecisions;
    const decisions = kind === 'approval' ? harnessApprovalDecisions(offered) : undefined;
    const unsupportedDecisionCount = Array.isArray(offered) ? offered.filter(value => typeof value !== 'string' || !decisions?.includes(value)).length : 0;
    if (kind === 'approval' && !decisions?.length) kind = 'unsupported';
    const approval=approvalContext(request);
    const detail=approval?approval.reason??'':['reason','command','path','toolName'].flatMap(key=>typeof params[key]==='string'?[params[key]]:[]).join('\n');
    const title=typeof params.title==='string'?params.title:undefined;
    return [{id: request.id, ...scope, kind, detail, title,...(approval?{approval}:{}), questions: questions?.filter((q): q is HarnessQuestion => !!q), decisions, unsupportedDecisionCount}];
}
function question(value: unknown): HarnessQuestion | undefined {
    if (!value || typeof value !== 'object') return;
    const q = value as Record<string, unknown>;
    if (typeof q.id !== 'string' || !q.id || typeof q.question !== 'string') return;
    if (['multiSelect', 'isSecret', 'isOther'].some(key => q[key] !== undefined && typeof q[key] !== 'boolean')) return;
    const options = Array.isArray(q.options) ? q.options : undefined;
    if (q.options != null && !options || options?.some(o => !o || typeof o.label !== 'string' || !o.label || o.label.includes('\0')
        || o.description !== undefined && typeof o.description !== 'string')) return;
    return {id: q.id, question: q.question, header: typeof q.header === 'string' ? q.header : undefined,
        multiSelect: q.multiSelect as boolean | undefined, isSecret: q.isSecret as boolean | undefined,
        isOther: q.isOther as boolean | undefined, options: options?.map(o => ({label: o.label, description: o.description}))};
}

/** Copy only explicit protocol context; shell contents never imply purpose or authorization scope. */
function approvalContext(request:HarnessEvent['message']):HarnessApprovalContext|undefined {
    const kind=request.method==='item/commandExecution/requestApproval'?'command':request.method==='item/fileChange/requestApproval'?'file-change':undefined;
    if(!kind)return;
    const params=request.params??{},text=(key:string)=>typeof params[key]==='string'?params[key] as string:undefined;
    return {kind,reason:text('reason'),command:text('command'),path:text('path'),cwd:text('cwd'),toolName:text('toolName')};
}
