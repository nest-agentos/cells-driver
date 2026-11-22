import { FSError, type FileStorageBackend, type FileReader, type FileMutations, type FileStat, type OperationOptions,
    type FileListOptions, type FileReadOptions, type ReplaceCondition } from '@nestos/vfs-core';
import type { HttpConnectionOptions } from '../transport';
import { WebDavTransport, WebDavMutationError } from './transport';
import { davPath, davUrl, hrefPath } from './paths';
import { lockRequest, multistatus, propertyRequest } from './xml';

/** A collection URL is the complete independent DAV namespace. */
export class WebDavBackend implements FileStorageBackend {
    readonly name = 'webdav';
    readonly files: FileReader;
    mutations?: FileMutations;
    private readonly http: WebDavTransport;
    private initialized = false;
    private locks = false;
    private structuralVersions = false;
    constructor(private readonly config: HttpConnectionOptions) {
        if (config.maxReadBytes !== undefined && (!Number.isSafeInteger(config.maxReadBytes) || config.maxReadBytes < 0)) throw new FSError('EINVAL', 'Invalid WebDAV read limit');
        this.http = new WebDavTransport(config);
        this.files = { stat: (path, opts) => this.stat(path, opts), statType: (path, opts) => this.stat(path, opts),
            list: (path, opts) => this.list(path, opts), read: (path, opts) => this.read(path, opts) };
    }
    async init(options?: OperationOptions): Promise<void> {
        if (this.initialized) return;
        const reply = await this.http.request('', 'OPTIONS', {}, undefined, options, 64 * 1024);
        const allow = new Set((reply.headers.get('allow') ?? '').toUpperCase().split(/\s*,\s*/));
        const dav = (reply.headers.get('dav') ?? '').split(/\s*,\s*/);
        if (!allow.has('PROPFIND') || !dav.some(value => value === '1' || value === '2'))
            throw new FSError('ECAPABILITY', 'WebDAV is unavailable at this address; verify the DAV collection URL and enable the service');
        this.locks = dav.includes('2') && allow.has('LOCK') && allow.has('UNLOCK');
        this.structuralVersions = reply.headers.get('x-cells-dav-structural-conditions') === 'if-match';
        if (['PUT', 'MKCOL', 'MOVE', 'DELETE'].every(method => allow.has(method))) this.mutations = this.makeMutations();
        if ((await this.stat('', options))?.kind !== 'directory') throw new FSError('ENOTDIR', 'WebDAV address must identify a collection');
        this.initialized = true;
    }
    async close() { this.http.close(); }
    private async properties(path: string, depth: '0' | '1', options?: OperationOptions) {
        const reply = await this.http.request(path, 'PROPFIND', { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, propertyRequest, options);
        if (reply.status !== 207) throw new FSError('EIO', 'Expected WebDAV multistatus', 'protocol');
        return multistatus(new TextDecoder().decode(reply.data)).map(item => ({ path: hrefPath(this.http.root, item.href), stat: item.stat }));
    }
    private async stat(path: string, options?: OperationOptions): Promise<FileStat | null> {
        try {
            const rows = await this.properties(path, '0', options);
            if (rows.length !== 1 || rows[0].path !== path) throw new FSError('EIO', 'Unexpected WebDAV resource', 'protocol');
            return rows[0].stat;
        } catch (error) { if (error instanceof FSError && error.code === 'ENOENT') return null; throw error; }
    }
    private async list(path: string, options?: FileListOptions) {
        if (options?.cursor) throw new FSError('EINVAL', 'WebDAV cursor unsupported');
        const rows = await this.properties(path, '1', options), prefix = path ? path + '/' : '', names = new Set<string>();
        if (!rows.some(row => row.path === path && row.stat.kind === 'directory')) throw new FSError('ENOTDIR', 'WebDAV collection missing');
        const entries = rows.filter(row => row.path !== path).map(row => {
            const name = row.path.slice(prefix.length);
            if (!row.path.startsWith(prefix) || !name || name.includes('/') || names.has(name)) throw new FSError('EIO', 'Invalid WebDAV directory member', 'protocol');
            names.add(name); return { name, stat: row.stat };
        });
        return { entries, nextCursor: null };
    }
    private async read(path: string, options?: FileReadOptions) {
        if (options?.offset || options?.length !== undefined) throw new FSError('ECAPABILITY', 'WebDAV ranged reads unsupported');
        const reply = await this.http.request(path, 'GET', options?.ifRevision ? { 'If-Match': etag(options.ifRevision) } : {}, undefined, options, this.config.maxReadBytes ?? 32 * 1024 * 1024);
        if (reply.status !== 200) throw new FSError('EIO', 'Unexpected partial WebDAV response', 'protocol');
        const revision = reply.headers.get('etag') ?? undefined;
        if (options?.ifRevision && revision !== options.ifRevision) throw new FSError('ECONFLICT', 'WebDAV read version changed');
        return { data: reply.data, revision };
    }
    private makeMutations(): FileMutations {
        return { replace: (path, data, condition, options) => this.replace(path, data, condition, options),
            mkdir: async (path, options) => { await this.http.request(mutationPath(path), 'MKCOL', {}, undefined, options); return { kind: 'directory' }; },
            rename: (from, to, options) => this.rename(from, to, options),
            remove: (path, options) => this.remove(path, options) };
    }
    private async rename(from: string, to: string, options?: OperationOptions): Promise<void> {
        mutationPath(from);
        const headers = { Destination: davUrl(this.http.root, mutationPath(to)).href, Overwrite: 'F' };
        const condition = this.structuralVersions ? this.structuralCondition(await this.stat(from, options)) : {};
        await this.http.request(from, 'MOVE', {...headers, ...condition}, undefined, options);
    }
    private async remove(path: string, options?: OperationOptions): Promise<void> {
        mutationPath(path);
        const stat = await this.stat(path, options);
        if (stat?.kind === 'directory' && (await this.list(path, options)).entries.length)
            throw new FSError('ENOTEMPTY', 'WebDAV directory must be empty; delete children explicitly');
        await this.http.request(path, 'DELETE', this.structuralVersions ? this.structuralCondition(stat) : {}, undefined, options);
    }
    private structuralCondition(stat: FileStat | null): Record<string, string> {
        if (!stat) throw new FSError('ENOENT', 'WebDAV resource no longer exists');
        return { 'If-Match': etag(stat.revision ?? '') };
    }
    private async replace(path: string, data: Uint8Array, condition: ReplaceCondition, options?: OperationOptions): Promise<FileStat> {
        mutationPath(path);
        const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
        headers.set(condition.kind === 'create-only' ? 'If-None-Match' : 'If-Match', condition.kind === 'create-only' ? '*' : etag(condition.revision));
        const token = this.locks && condition.kind === 'match' ? await this.lock(path, options) : undefined;
        if (token) headers.set('If', `(${token})`);
        try {
            const reply = await this.http.request(path, 'PUT', headers, data.slice().buffer, options, 64 * 1024);
            return { kind: 'file', size: data.byteLength, revision: reply.headers.get('etag') ?? undefined };
        } finally {
            if (token) await this.http.request(path, 'UNLOCK', { 'Lock-Token': token }, undefined, { timeoutMs: 5000 })
                .catch(error => { console.warn('[webdav] unlock failed', { operation: 'webdav.unlock', stage: 'cleanup', result: 'failure', code: error instanceof FSError ? error.code : 'EIO' }); });
        }
    }
    private async lock(path: string, options?: OperationOptions): Promise<string> {
        const reply = await this.http.request(path, 'LOCK', { Depth: '0', Timeout: 'Second-60', 'Content-Type': 'application/xml; charset=utf-8' }, lockRequest, options, 64 * 1024);
        const token = reply.headers.get('lock-token');
        if (!token || !/^<[^<>\s]+>$/.test(token)) this.http.retainUnknown(path, new WebDavMutationError('EIO', reply.operationId, 'unknown', 'DAV_LOCK_TOKEN_MISSING'));
        return token;
    }
}

function etag(value: string): string {
    if (!/^"[^"\r\n]*"$/.test(value)) throw new FSError('ECONFLICT', 'A strong read version is required; reopen and compare before saving');
    return value;
}

function mutationPath(path: string): string {
    if (!davPath(path)) throw new FSError('EACCES', 'The WebDAV collection root cannot be modified');
    return path;
}
