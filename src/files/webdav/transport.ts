import { checkOperation, FSError, FSOperationCancelledError, operationScope, type FSErrorCode, type OperationOptions,
    type OperationOutcome } from '@nestos/vfs-core';
import type { HttpConnectionOptions } from '../transport';
import { boundedBody } from '../transport/body';
import { HttpMutationError } from '../transport/mutation';
import { HttpResponseError, remoteCode, statusCode } from '../transport/errors';
import { requestId } from '../request-id';
import { davRoot, davUrl } from './paths';

export interface DavReply { status: number; headers: Headers; data: Uint8Array; operationId: string; }
export class WebDavMutationError extends HttpMutationError {
    constructor(code: FSErrorCode, operationId: string, outcome: OperationOutcome, readonly remoteCode?: string, readonly httpStatus?: number) {
        super(code, operationId, outcome);
        this.message = `WebDAV ${remoteCode ?? code}: ${outcome} (${operationId}). Keep local changes; inspect the remote result before retrying.`;
    }
}

/** No retry, redirect or native Cells discovery; each write has one stable identity. */
export class WebDavTransport {
    readonly root: URL;
    private readonly lifetime = new AbortController();
    private readonly uncertain = new Map<string, WebDavMutationError>();
    constructor(private readonly config: HttpConnectionOptions) { this.root = davRoot(config.endpoint); }
    close() { this.lifetime.abort(); }
    retainUnknown(path: string, error: WebDavMutationError): never { this.uncertain.set(path, error); throw error; }
    request(path: string, method: string, headers: HeadersInit = {}, body?: BodyInit, options?: OperationOptions, limit = 4 * 1024 * 1024) {
        return this.perform(path, method, headers, body, options, limit);
    }
    private async perform(path: string, method: string, input: HeadersInit, body: BodyInit | undefined, options: OperationOptions | undefined, limit: number): Promise<DavReply> {
        const url = davUrl(this.root, path), mutation = !['OPTIONS', 'GET', 'HEAD', 'PROPFIND'].includes(method);
        if (mutation && method !== 'UNLOCK' && this.uncertain.size) throw this.uncertain.values().next().value!;
        const id = requestId(), started = Date.now(), scope = operationScope({ ...options, timeoutMs: options?.timeoutMs ?? this.config.timeoutMs ?? 30_000 }, this.lifetime.signal);
        let sent = false;
        try {
            checkOperation(scope.options);
            const headers = await this.headers(input); checkOperation(scope.options); headers.set('X-Operation-Id', id);
            sent = true;
            const response = await (this.config.fetch ?? globalThis.fetch)(url, { method, headers, body, signal: scope.options.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
            const reply = { status: response.status, headers: response.headers, data: await boundedBody(response, response.ok ? limit : 64 * 1024), operationId: id };
            if (!response.ok) throw replyError(reply, mutation);
            if (mutation && !writeStatuses[method]?.includes(reply.status)) throw new WebDavMutationError('EIO', id, 'unknown', 'DAV_UNEXPECTED_STATUS', reply.status);
            this.log(method, id, started, 'success'); return reply;
        } catch (cause) {
            const error = this.failure(cause, mutation, sent, id, scope.options);
            if (error instanceof WebDavMutationError && ['unknown', 'partial'].includes(error.outcome)) this.uncertain.set(path, error);
            this.log(method, id, started, 'failure', error); throw error;
        } finally { scope.dispose(); }
    }
    private failure(cause: unknown, mutation: boolean, sent: boolean, id: string, options: OperationOptions): FSError {
        if (cause instanceof WebDavMutationError) return cause;
        const cancelled=options.signal?.aborted, reason=options.signal?.reason;
        const timedOut=cancelled && reason instanceof FSOperationCancelledError && reason.timedOut;
        if (mutation && sent) return new WebDavMutationError(cause instanceof FSError ? cause.code : timedOut ? 'ETIMEDOUT' : cancelled ? 'ECANCELLED' : 'EIO', id, 'unknown',
            timedOut?'DAV_REQUEST_TIMEOUT':cancelled?'DAV_REQUEST_CANCELLED':cause instanceof FSError?'DAV_RESPONSE_UNREADABLE':'DAV_NETWORK_FAILURE');
        if (cause instanceof FSError) return cause;
        if (cancelled) return new FSOperationCancelledError('not-committed', timedOut);
        return new FSError('EIO', 'WebDAV network connection failed', 'connect');
    }
    private async headers(input: HeadersInit): Promise<Headers> {
        const headers = new Headers(input);
        if (!this.config.anonymous) {
            const secret = await this.config.credential();
            if (this.config.username !== undefined && (!this.config.username || /[:\r\n]/.test(this.config.username))) throw new FSError('EINVAL', 'Invalid WebDAV username');
            const bytes = new TextEncoder().encode(`${this.config.username}:${secret}`);
            headers.set('Authorization', this.config.username === undefined ? `Bearer ${secret}` : `Basic ${btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))}`);
        }
        return headers;
    }
    private log(method: string, operationId: string, started: number, result: string, error?: FSError) {
        const data = { operation: `webdav.${method.toLowerCase()}`, stage: 'protocol', result, operationId, durationMs: Date.now() - started,
            code: error?.code, remoteCode: error instanceof WebDavMutationError || error instanceof HttpResponseError ? error.remoteCode : undefined,
            httpStatus: error instanceof WebDavMutationError || error instanceof HttpResponseError ? error.httpStatus : undefined,
            outcome: error instanceof HttpMutationError ? error.outcome : undefined };
        if (error) console.warn('[webdav] request finished', data); else console.debug('[webdav] request finished', data);
    }
}

const writeStatuses: Record<string, number[]> = {PUT:[201,204],MKCOL:[201],MOVE:[201,204],DELETE:[204],LOCK:[200,201],UNLOCK:[204]};

function replyError(reply: DavReply, mutation: boolean): FSError {
    let body: { code?: unknown; outcome?: unknown } = {};
    try { body = JSON.parse(new TextDecoder().decode(reply.data)) ?? {}; } catch { /* Generic DAV errors may contain XML. */ }
    const safeCode = typeof body.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(body.code) ? body.code : undefined;
    const code = remoteCode(safeCode, reply.status === 423 ? 'EBUSY' : statusCode(reply.status));
    if (!mutation) return new HttpResponseError(code, `WebDAV ${reply.status}${safeCode ? ` (${safeCode})` : ''}`, reply.status, safeCode);
    const outcome = ['not-started', 'not-committed', 'partial', 'unknown'].includes(String(body.outcome)) ? body.outcome as OperationOutcome
        : reply.status >= 400 && reply.status < 500 ? 'not-committed' : 'unknown';
    return new WebDavMutationError(code, reply.operationId, outcome, safeCode, reply.status);
}
