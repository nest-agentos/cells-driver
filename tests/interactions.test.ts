import {expect, it, vi} from 'vitest';
import {HarnessConversation} from '../src/harness/conversation';
import {nativeRequest} from '../src/harness/interactions';
import type {HarnessRecovery} from '../src/harness/conversation-journal';
const profile = {id: 'codex', kind: 'codex', projectRuntime: true, workspaces: [{id: 'p'}], capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true}};
const request = {id: 'q', method: 'item/tool/requestUserInput', params: {threadId: 's', questions: [
    {id: 'q', header: 'Choose', question: 'Choose', multiSelect: true, isSecret: false, isOther: true, options: [{label: 'A', description: 'First'}, {label: 'B'}]},
]}};
function fixture() {
    const client = {profiles: async () => ({epoch: 'e', profiles: [profile]}), read: async () => ({session: {id: 's', title: 'S', cwd: '/p', status: 'idle', owned: true, resumable: true}, turns: []}),
        eventSnapshot: vi.fn(async () => ({epoch: 'events', cursor: 1, gap: false, events: [], requests: [request]})),
        operation: vi.fn(async () => ({outcome: 'unknown', requestId: 'reply'})), respond: vi.fn(async () => {}), close: vi.fn(async () => {})};
    return client;
}
it('preserves native input semantics and rejects malformed structured questions explicitly', () => {
    expect(nativeRequest(request)[0].questions![0]).toMatchObject({header: 'Choose', multiSelect: true, isOther: true, options: [{label: 'A', description: 'First'}, {label: 'B'}]});
    expect(nativeRequest({...request, params: {questions: [{question: 'Missing ID'}]}})[0].kind).toBe('unsupported');
});
it('restores outstanding questions on initial read without requiring another execution event', async () => {
    const client = fixture(), first = new HarnessConversation(client as never, profile, 'p', 's');
    expect((await first.read()).requests).toHaveLength(1); await first.close();
    const reopened = new HarnessConversation(client as never, profile, 'p', 's');
    expect(await reopened.read()).toMatchObject({canRespond: true, requests: [{id: 'q', kind: 'input'}]}); await reopened.close();
});
it('persists unknown response receipts independently and never persists secret answers or repeats the reply', async () => {
    const client = fixture(); let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    client.respond.mockRejectedValueOnce({outcome: 'unknown'});
    const first = new HarnessConversation(client as never, profile, 'p', 's', true, journal); await first.read();
    await expect(first.respond('q', {answers: {q: {answers: ['private answer']}}})).rejects.toMatchObject({outcome: 'unknown'});
    expect(record!.responses).toHaveLength(1); expect(JSON.stringify(record)).not.toContain('private answer'); await first.close();
    const reopened = new HarnessConversation(client as never, profile, 'p', 's', true, journal); await reopened.read();
    expect(reopened.snapshot().requests[0].responding).toBe(true);
    await expect(reopened.respond('q', {answers: {}})).rejects.toMatchObject({code: 'EACCES'});
    expect(client.respond).toHaveBeenCalledOnce();
    client.operation.mockResolvedValue({outcome: 'committed', requestId: record!.responses![0].requestId} as never);
    client.eventSnapshot.mockResolvedValue({epoch: 'events', cursor: 2, gap: false, events: [], requests: []});
    expect((await reopened.reconcile()).requests).toEqual([]); expect(record!.responses).toEqual([]); await reopened.close();
});

const policyDecision = {acceptWithExecpolicyAmendment: {execpolicy_amendment: ['/bin/bash', '-lc', 'python3 script.py']}};
const approvalRequest = {id: 'approval', method: 'item/commandExecution/requestApproval',
    params: {threadId: 's', command: 'python3 script.py', availableDecisions: ['accept', policyDecision, 'cancel']}};
it('preserves usable choices in mixed approvals and never replaces the command with raw protocol JSON', () => {
    expect(nativeRequest(approvalRequest)[0]).toMatchObject({kind: 'approval', detail: '',approval:{kind:'command',command:'python3 script.py'},
        decisions: ['accept', 'cancel'], unsupportedDecisionCount: 1});
    expect(nativeRequest({...approvalRequest, params: {...approvalRequest.params, availableDecisions: ['accept', {futurePolicy: {}}, 'cancel']}})[0])
        .toMatchObject({kind: 'approval', decisions: ['accept', 'cancel']});
});
it.each(['accept', 'cancel'])('forwards only the explicitly selected offered native choice %s', async decision => {
    const client = fixture(); client.eventSnapshot.mockResolvedValue({epoch: 'events', cursor: 1, gap: false, events: [], requests: [approvalRequest]} as never);
    const conversation = new HarnessConversation(client as never, profile, 'p', 's'); await conversation.read();
    await conversation.respond('approval', {decision});
    expect(client.respond).toHaveBeenCalledWith('codex', 'approval', {decision}, expect.anything());
    await conversation.close();
});
it('rejects invented approval or modified policy before creating any native response', async () => {
    const client = fixture(); client.eventSnapshot.mockResolvedValue({epoch: 'events', cursor: 1, gap: false, events: [], requests: [approvalRequest]} as never);
    const conversation = new HarnessConversation(client as never, profile, 'p', 's'); await conversation.read();
    await expect(conversation.respond('approval', {decision: 'acceptForSession'})).rejects.toMatchObject({code: 'EINVAL'});
    await expect(conversation.respond('approval', {decision: {acceptWithExecpolicyAmendment: {execpolicy_amendment: ['/bin/bash']}}})).rejects.toMatchObject({code: 'EINVAL'});
    expect(client.respond).not.toHaveBeenCalled(); expect(conversation.snapshot().requests).toHaveLength(1); await conversation.close();
});

it('does not expose mutable approval choices and fails closed when no advertised choice is supported', async () => {
    const unsupported = nativeRequest({...approvalRequest, params: {...approvalRequest.params, availableDecisions: [policyDecision]}})[0];
    expect(unsupported).toMatchObject({kind: 'unsupported', decisions: [], detail: '',approval:{command:'python3 script.py'}});
    expect(unsupported.detail).not.toContain('availableDecisions');
    const client = fixture(); client.eventSnapshot.mockResolvedValue({epoch: 'events', cursor: 1, gap: false, events: [], requests: [approvalRequest]} as never);
    const conversation = new HarnessConversation(client as never, profile, 'p', 's');
    const snapshot = await conversation.read(); snapshot.requests[0].decisions!.push('acceptForSession');
    await expect(conversation.respond('approval', {decision: 'acceptForSession'})).rejects.toMatchObject({code: 'EINVAL'});
    expect(client.respond).not.toHaveBeenCalled(); await conversation.close();
});

it('keeps explicit approval context separate from the human reason and ignores unrelated payload',()=>{
 const command='python3 - <<\'PY\'\nprint("<script>not markup</script>")\nPY';
 const row=nativeRequest({...approvalRequest,params:{...approvalRequest.params,title:'Update browser verification',reason:'May I update the verification script?',command,cwd:'/project',path:'/project/verify.mjs',unrelated:'not presentation'}})[0];
 expect(row).toMatchObject({title:'Update browser verification',detail:'May I update the verification script?',approval:{kind:'command',reason:'May I update the verification script?',command,cwd:'/project',path:'/project/verify.mjs'}});
 expect(row.detail).not.toContain(command);expect(JSON.stringify(row)).not.toContain('not presentation');
});
it('does not infer an approval reason or file path from shell contents',()=>{
 const row=nativeRequest({...approvalRequest,params:{...approvalRequest.params,reason:{unexpected:true},command:'rm -rf /some/path'}})[0];
 expect(row.detail).toBe('');expect(row.approval).toMatchObject({kind:'command',command:'rm -rf /some/path'});
 expect(row.approval?.reason).toBeUndefined();expect(row.approval?.path).toBeUndefined();
});
it('preserves file approval identity and isolates context snapshots from caller mutation',async()=>{
 const file={...approvalRequest,method:'item/fileChange/requestApproval',params:{...approvalRequest.params,path:'/project/file.ts',reason:'Update the requested view'}};
 const client=fixture();client.eventSnapshot.mockResolvedValue({epoch:'events',cursor:1,gap:false,events:[],requests:[file]} as never);
 const conversation=new HarnessConversation(client as never,profile,'p','s');const first=await conversation.read();
 expect(first.requests[0]).toMatchObject({approval:{kind:'file-change',path:'/project/file.ts',reason:'Update the requested view'}});
 first.requests[0].approval!.path='/other';expect(conversation.snapshot().requests[0].approval?.path).toBe('/project/file.ts');
 await conversation.close();
});
it('offers only one-time decisions for a Codex MCP tool approval', async () => {
    const request = {id: 'browser-approval', method: 'mcpServer/elicitation/request', params: {
        mode: 'form', serverName: 'browser', message: 'Open the page?',
        requestedSchema: {type: 'object', properties: {}},
        _meta: {codex_approval_kind: 'mcp_tool_call', tool_name: 'open', persist: ['session', 'always']},
    }};
    expect(nativeRequest(request)[0]).toMatchObject({
        kind: 'approval', title: 'browser / open', decisions: ['accept', 'decline'],
    });
    expect(nativeRequest({...request,params:{...request.params,turnId:'turn-2'}},'event-epoch')[0].interactionScope)
        .toBe(JSON.stringify(['event-epoch','turn-2']));
    expect(nativeRequest({...request, params: {...request.params,
        cellsSiteApproval: {origin: 'https://example.test', revision: 3, level: 'write'},
    }})[0]).toMatchObject({title: 'https://example.test · open',
        decisions: ['decline', 'accept', 'allowSiteRead', 'allowSiteReadWrite']});
    expect(nativeRequest({...request, params: {...request.params, mode: 'url'}})[0].kind).toBe('unsupported');
    expect(nativeRequest({...request, params: {...request.params,
        requestedSchema: {type: 'object', properties: {query: {type: 'string'}}},
    }})[0].kind).toBe('unsupported');
    const client = fixture();
    const pending = {...request, params: {...request.params, threadId: 's'}};
    client.eventSnapshot.mockResolvedValue({epoch: 'events', cursor: 1, gap: false, events: [], requests: [pending]} as never);
    const conversation = new HarnessConversation(client as never, profile, 'p', 's');
    try {
        expect((await conversation.read()).canRespond).toBe(true);
        await expect(conversation.respond(request.id, {decision: 'acceptForSession'})).rejects.toMatchObject({code: 'EINVAL'});
        expect(client.respond).not.toHaveBeenCalled();
        await conversation.respond(request.id, {decision: 'accept'});
        expect(client.respond).toHaveBeenCalledWith('codex', request.id, {decision: 'accept'}, expect.any(Object));
    } finally {
        await conversation.close();
    }
});
