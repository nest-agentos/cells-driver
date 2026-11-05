import {FSError} from '@nestos/vfs-core';

/** Fixed application transport; no MCP negotiation or tool discovery. */
export class CellsHttpClient {
    private descriptor?: Record<string, unknown>;
    constructor(private readonly base: URL, private readonly fetch: typeof globalThis.fetch) {}
    async connect(signal?:AbortSignal): Promise<void> {
        const value = await this.request('v1/capabilities',undefined,signal?AbortSignal.any([signal,AbortSignal.timeout(30_000)]):undefined) as Record<string, unknown>;
        this.descriptor = value.node as Record<string, unknown>;
        if (!this.descriptor || (this.descriptor.api as {version?: unknown} | undefined)?.version !== 1)
            throw new FSError('ECAPABILITY', 'Unsupported Cells API');
    }
    metadata() { return this.descriptor; }
    async close(): Promise<void> {}
    async call(name: string, args: object, options: {signal?: AbortSignal; timeout: number | undefined}) {
        const match = /^(harness|project)_([a-z_]+)$/.exec(name);
        if (!match) throw new FSError('ECAPABILITY', 'Unknown Cells operation');
        const path = `v1/api/${match[1] === 'project' ? 'projects' : 'harness'}/${match[2]}`;
        const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, Math.ceil(options.timeout ?? 30_000)))]) : AbortSignal.timeout(Math.max(1, Math.ceil(options.timeout ?? 30_000)));
        const result = await this.request(path, args, signal) as {ok?: boolean; value?: unknown; error?: unknown};
        if (!result || typeof result.ok !== 'boolean') throw new FSError('EIO', 'Invalid Cells operation result');
        if (!result.ok) {
            const error = result.error as {code?: unknown; outcome?: unknown};
            const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'CELLS_OPERATION_FAILED';
            throw Object.assign(new FSError('EIO', code), {remoteCode: code, outcome: error?.outcome === 'not-committed' ? 'not-committed' : 'unknown'});
        }
        return result.value;
    }
    private async request(path: string, body?: object, signal?: AbortSignal): Promise<unknown> {
        const response = await this.fetch(new URL(path, this.base), {method: body ? 'POST' : 'GET',
            headers: body ? {'content-type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined,
            signal: signal ?? AbortSignal.timeout(30_000), redirect: 'error'});
        const raw = await readBounded(response);
        let value: unknown;
        try {value = JSON.parse(raw);} catch {throw new FSError('EIO', 'Invalid Cells response');}
        if (!response.ok) {
            const rawCode = (value as {code?: unknown})?.code;
            const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(rawCode) ? rawCode : undefined;
            throw Object.assign(new FSError('EIO', typeof code === 'string' ? code : 'Cells request rejected'),
                {remoteCode: typeof code === 'string' ? code : undefined, outcome: response.status < 500 ? 'not-committed' : 'unknown'});
        }
        return value;
    }
}
async function readBounded(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) throw new FSError('EIO', 'Empty Cells response');
    const decoder = new TextDecoder(), chunks: string[] = []; let bytes = 0;
    try {
        while (true) {
            const row = await reader.read(); if (row.done) break;
            bytes += row.value.byteLength;
            if (bytes > 8 * 1024 * 1024) throw new FSError('EFBIG', 'Cells response exceeds limit');
            chunks.push(decoder.decode(row.value, {stream: true}));
        }
        return chunks.join('') + decoder.decode();
    } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}
