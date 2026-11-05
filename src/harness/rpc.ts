import { CellsHttpClient } from '../http-client';
import { checkOperation, operationScope, type OperationOptions } from '@nestos/vfs-core';
import { NodeEventHub, requireEventCapability, type RemoteEventListener } from '../events';

export interface CellsRpc {
    call(name: string, args: object, options?: OperationOptions): Promise<unknown>;
    metadata?(options?: OperationOptions): Promise<Record<string, unknown> | undefined>;
    subscribe(plugin: string, args: Record<string, unknown>, listener: RemoteEventListener): () => void;
    close(): Promise<void>;
}

export function createCellsRpc(endpoint: string, fetch: typeof globalThis.fetch, sharedEvents?: NodeEventHub): CellsRpc {
    const base = new URL(endpoint.endsWith('/') ? endpoint : endpoint + '/');
    const events = sharedEvents ?? new NodeEventHub(new URL('v1/events',base),fetch);
    const client = new CellsHttpClient(base, fetch);
    const lifetime = new AbortController();
    let connecting: Promise<void> | undefined;
    const subscriptions = new Set<() => void>();
    const connect = () => connecting ??= client.connect(lifetime.signal).catch(error => {connecting = undefined; throw error;});
    const invoke = async <T>(options: OperationOptions | undefined, run: (scope: ReturnType<typeof operationScope>) => Promise<T>): Promise<T> => {
        const scope = operationScope({...options,timeoutMs:options?.timeoutMs ?? 30_000},lifetime.signal);
        try {
            checkOperation(scope.options);await waitFor(connect(),scope.options.signal);checkOperation(scope.options);
            return await run(scope);
        } finally {scope.dispose();}
    };
    return {
        call:(name,args,options) => invoke(options,scope => client.call(name,args,{signal:scope.options.signal,timeout:scope.remaining()})),
        metadata:options => invoke(options,async () => client.metadata()),
        subscribe(plugin,args,listener) {
            let stopped = false, stop: (() => void) | undefined;
            void connect().then(() => {
                if (stopped || lifetime.signal.aborted) return;
                const meta = client.metadata();
                const descriptor = meta as {events?: unknown} | undefined;
                requireEventCapability(descriptor?.events);
                stop = events.subscribe(plugin,args,listener);
            }).catch(error => { if (!stopped) listener.error(error); });
            const release = () => { stopped = true; stop?.(); subscriptions.delete(release); };
            subscriptions.add(release); return release;
        },
        async close() { lifetime.abort(); for (const stop of subscriptions) stop(); if (!sharedEvents) events.close(); await client.close(); },
    };
}
function waitFor(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return pending;
    return new Promise((resolve,reject) => {
        const abort = () => { cleanup(); try { checkOperation({signal}); } catch (error) { reject(error); } };
        const cleanup = () => signal.removeEventListener('abort',abort);
        signal.addEventListener('abort',abort,{ once:true });
        if (signal.aborted) abort();
        void pending.then(() => { cleanup(); resolve(); },error => { cleanup(); reject(error); });
    });
}
