import { validateAuthorization, type RemoteAuthorization } from './authorization';
import { createHttpSourceProvider, type HttpSourceProvider, type RemoteConnection } from './files/index';
import { FSError, createFileSystemSource, FileStorageAdapter, type FileSystemSourceOwner } from '@nestos/vfs-core';
import { HttpFSBackend } from './files/index';
import { HttpSyncClient } from './sync/client';
import { CellsHarnessClient } from './harness/client';
import { createCellsRpc, type CellsRpc } from './harness/rpc';
import { CellsProjectClient, type ProjectClient, type RemoteProject } from './projects';
import { createProjectProcess } from './project-process';
import type { HarnessClient, HarnessProfile } from './harness/contracts';
import type { HarnessConversationJournal } from './harness/conversation-journal';
import { HarnessConversation, type HarnessConversationPort } from './harness/conversation';
import { HarnessStatusObserver, type HarnessStatusPort } from './harness/status-observer';
import { NodeEventHub } from './events';
import {readNodeStatus, type CellsNodeStatus} from './node-status';

type Connection = Omit<RemoteConnection, 'alias'>;
export interface CellsDescriptor { authorization?: RemoteAuthorization; version: 1; httpEndpoint: string; serverId: string | null; fileProtocol: 'fs-agent-http-v1'; harness: boolean; projects?: boolean; sync?: boolean; projectProtocol?: string; directorySync?: boolean; directorySyncVersion?: number; fileSearch?: boolean; directoryEvents?: boolean; events?: {version:1;transport:'sse';endpoint:'/v1/events'}; }
export interface CellsDriver extends HttpSourceProvider {
    nodeStatus(connection:Connection,options?:import('@nestos/vfs-core').OperationOptions):Promise<CellsNodeStatus>;
    observeHarness(client: HarnessClient, writable?: boolean, options?: {watchFiles?: boolean}): HarnessStatusPort;
    open(connection: RemoteConnection & {serverProjectId?: string; serverProjectRevision?: number; access?: 'ro' | 'rw'}, options?: import('@nestos/vfs-core').OperationOptions): ReturnType<HttpSourceProvider['open']>;
    resolveCredential(reference: string): Promise<string>;
    discover(connection: Connection, options?: import('@nestos/vfs-core').OperationOptions): Promise<CellsDescriptor>;
    discoverDraft(connection: Connection,password:string,options?:import('@nestos/vfs-core').OperationOptions):Promise<CellsDescriptor>;
    conversation(client: HarnessClient, profile: HarnessProfile, workspaceId: string, sessionId?: string, writable?: boolean, journal?: HarnessConversationJournal): HarnessConversationPort;
    harness(connection: Connection): HarnessClient;
    projects(connection: Connection): ProjectClient;
    projectProcess(connection: Connection, project: RemoteProject, spec: Parameters<HttpSourceProvider['process']>[1]): ReturnType<HttpSourceProvider['process']>;
    sync(connection: Connection, historyEpoch: string): HttpSyncClient;
}

/** A single credential owner; file, sync and harness clients retain independent lifetimes. */
export function createCellsDriver(resolveCredential?: (reference: string) => string | Promise<string>, fetch = globalThis.fetch): CellsDriver {
    const secrets = new Map<string, string>();
    const statusLifetime = new AbortController();
    const eventHubs = new Map<string, NodeEventHub>();
    const eventHub = (connection: Connection): NodeEventHub => {
        const endpoint = new URL(connection.endpoint.endsWith('/') ? connection.endpoint : connection.endpoint+'/');
        const key = JSON.stringify([endpoint.href, connection.credentialRef, connection.username, connection.anonymous, connection.authorization]);
        let hub = eventHubs.get(key);
        if (!hub) { hub = new NodeEventHub(new URL('v1/events',endpoint),authenticatedFetch(connection,credential,fetch)); eventHubs.set(key,hub); }
        return hub;
    };
    const credential = async (ref: string) => {
        const value = secrets.get(ref) ?? await resolveCredential?.(ref);
        if (!value) throw new FSError('EACCES', 'Remote credentials required'); return value;
    };
    const files = createHttpSourceProvider(credential, fetch, eventHub);
    const openFiles = files.open.bind(files);
    const disposeFiles = files.dispose.bind(files);
    const clients = new Set<{close(): Promise<void>}>();
    const processes = new Set<{release(): Promise<void>}>();
    const projectFiles = new Set<FileSystemSourceOwner>();
    return Object.assign(files, {
        nodeStatus:(connection:Connection,options?:import('@nestos/vfs-core').OperationOptions)=>readNodeStatus(connection,credential,fetch,{...options,signal:options?.signal?AbortSignal.any([options.signal,statusLifetime.signal]):statusLifetime.signal}),
        resolveCredential: credential,
        observeHarness: (client: HarnessClient, writable = true, options?: {watchFiles?: boolean}) => new HarnessStatusObserver(client, Date.now, writable, options?.watchFiles ?? true),
        conversation: (client: HarnessClient, profile: HarnessProfile, workspaceId: string, sessionId?: string, writable?: boolean, journal?: HarnessConversationJournal) => new HarnessConversation(client, profile, workspaceId, sessionId, writable, journal),
        discover: (connection:Connection,options?:import('@nestos/vfs-core').OperationOptions)=>discoverNode(connection,credential,fetch,clients,options),
        discoverDraft: (connection:Connection,password:string,options?:import('@nestos/vfs-core').OperationOptions)=>
            discoverNode(connection,password?async()=>password:credential,fetch,clients,options),
        setCredential(ref: string, value: string) {
            const previous = secrets.get(ref); secrets.set(ref, value);
            for (const hub of eventHubs.values()) hub.reconnect();
            return () => { if (previous === undefined) secrets.delete(ref); else secrets.set(ref, previous); for (const hub of eventHubs.values()) hub.reconnect(); };
        },
        clearCredential(ref: string) { secrets.delete(ref); for (const hub of eventHubs.values()) hub.reconnect(); },
        harness(connection: Connection) {
            const snapshot = { ...connection };
            const client = new CellsHarnessClient(createCellsRpc(snapshot.endpoint, authenticatedFetch(snapshot, credential, fetch), eventHub(snapshot)));
            const close = client.close.bind(client);
            client.close = async () => { clients.delete(client); await close(); };
            clients.add(client); return client;
        },
        async open(connection: RemoteConnection & {serverProjectId?: string; serverProjectRevision?: number; access?: 'ro' | 'rw'}, options?: import('@nestos/vfs-core').OperationOptions) {
            if (!connection.serverProjectId) return openFiles(connection,options);
            const scopedFetch: typeof globalThis.fetch = (input,init) => {
                const headers=new Headers(init?.headers); headers.set('x-fsagent-project',connection.serverProjectId!);
                headers.set('x-fsagent-project-revision',String(connection.serverProjectRevision));
                headers.set('x-fsagent-project-readonly',String(connection.access==='ro'));
                return fetch(input,{...init,headers});
            };
            const backend=new HttpFSBackend({...connection,credential:() => credential(connection.credentialRef),fetch:scopedFetch});
            try {
                await backend.init(options);
                const owner=await createFileSystemSource({backend:new FileStorageAdapter(backend),viewId:`project:${connection.serverProjectId}:${connection.alias}`,access:connection.access ?? 'ro',tags:false});
                const dispose=owner.dispose.bind(owner);
                owner.dispose=async () => {await dispose();projectFiles.delete(owner);};
                projectFiles.add(owner);return owner;
            }
            catch(error) {await backend.close();throw error;}
        },
        async projectProcess(connection: Connection, project: RemoteProject, spec: Parameters<HttpSourceProvider['process']>[1]) {
            const projects = new CellsProjectClient(createCellsRpc(connection.endpoint,authenticatedFetch(connection,credential,fetch),eventHub(connection)));
            try {
                const owner=createProjectProcess({...connection,credential:() => credential(connection.credentialRef),fetch,events:eventHub(connection)},projects,project,spec);
                const release=owner.release.bind(owner);
                owner.release=async () => {await release(); processes.delete(owner);};
                processes.add(owner); return owner;
            }
            catch(error) {await projects.close(); throw error;}
        },
        projects(connection: Connection) {
            const client = new CellsProjectClient(createCellsRpc(connection.endpoint,authenticatedFetch(connection,credential,fetch),eventHub(connection)));
            const close = client.close.bind(client);
            client.close = async () => { clients.delete(client); await close(); };
            clients.add(client); return client;
        },
        sync(connection: Connection, historyEpoch: string) { return new HttpSyncClient(files.transport(connection), historyEpoch); },
        async dispose() {
            statusLifetime.abort();
            const results = await Promise.allSettled([...processes].map(p => p.release()));
            results.push(...await Promise.allSettled([...clients].map(c => c.close())));
            results.push(...await Promise.allSettled([...projectFiles].map(owner => owner.dispose())));
            results.push(...await Promise.allSettled([disposeFiles()]));
            const errors = results.flatMap(r => r.status === 'rejected' ? [r.reason] : []);
            if (errors.length) throw new AggregateError(errors, 'cells resources failed to close');
            for (const hub of eventHubs.values()) hub.close(); eventHubs.clear();
            secrets.clear();
        },
    });
}
async function discoverCapabilities(rpc: CellsRpc,options?: import('@nestos/vfs-core').OperationOptions): Promise<CellsDescriptor> {
    const descriptor = await rpc.metadata?.(options);
    if (!descriptor) throw new FSError('ECAPABILITY', 'Cells API discovery unavailable');
    return descriptor as unknown as CellsDescriptor;
}

function authenticatedFetch(connection: Connection, credential: (ref: string) => Promise<string>, fetch: typeof globalThis.fetch): typeof globalThis.fetch {
    const endpoint = new URL(connection.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
        throw new FSError('EINVAL', 'Invalid agent endpoint');
    return async (input, init) => {
        const headers = new Headers(init?.headers);
        if (connection.authorization) { headers.set('x-cells-principal',connection.authorization.principalId); headers.set('x-cells-grant-revision',connection.authorization.revision); }
        if (connection.anonymous) { headers.delete('Authorization'); return boundedResponse(await fetch(input, {...init, headers, redirect:'error', credentials:'omit', cache:'no-store'})); }
        const secret = await credential(connection.credentialRef);
        const bytes = new TextEncoder().encode(`${connection.username}:${secret}`);
        if (connection.username !== undefined && (!connection.username || /[:\r\n]/.test(connection.username))) throw new FSError('EINVAL', 'Invalid username');
        headers.set('Authorization', connection.username === undefined ? `Bearer ${secret}` : `Basic ${btoa(Array.from(bytes,b => String.fromCharCode(b)).join(''))}`);
        const response = await fetch(input, { ...init, headers, redirect: 'error', credentials: 'omit', cache: 'no-store' });
        return boundedResponse(response);
    };
}

function boundedResponse(response: Response): Response {
    if (response.headers.get('content-type')?.startsWith('text/event-stream')) return response;
    if (!response.body) return response;
    let bytes = 0;
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk,controller) {
            bytes += chunk.byteLength;
            if (bytes > 32 * 1024 * 1024) throw new FSError('EFBIG', 'Harness response exceeds the read limit');
            controller.enqueue(chunk);
        },
    }));
    return new Response(stream,{ status:response.status,statusText:response.statusText,headers:response.headers });
}

async function discoverNode(connection:Connection,credential:(ref:string)=>Promise<string>,fetch:typeof globalThis.fetch,clients:Set<{close():Promise<void>}>,options?:import('@nestos/vfs-core').OperationOptions):Promise<CellsDescriptor> {
            const rpc = createCellsRpc(connection.endpoint, authenticatedFetch(connection, credential, fetch));
            clients.add(rpc);
            try {
                const value = await discoverCapabilities(rpc,options);
                if (value?.version !== 1 || value.fileProtocol !== 'fs-agent-http-v1' || typeof value.harness !== 'boolean' || typeof value.httpEndpoint !== 'string'
                    || !(value.serverId === null || typeof value.serverId === 'string')) throw new FSError('ECAPABILITY', 'Invalid cells discovery');
                const base = new URL(connection.endpoint.replace(/\/$/, '') + '/'), http = new URL(value.httpEndpoint, base);
                if (http.origin !== base.origin || http.username || http.password || http.search || http.hash) throw new FSError('EACCES', 'Invalid cells HTTP endpoint');
                const authorization = validateAuthorization(value.authorization);
                if (authorization && authorization.anonymous !== !!connection.anonymous)
                    throw new FSError('EACCES', 'Remote authentication mode changed');
                return { ...value, authorization, httpEndpoint: http.href.replace(/\/+$/, '') };
            } finally { clients.delete(rpc); await rpc.close(); }
}
