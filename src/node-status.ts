import {FSError, type OperationOptions} from '@nestos/vfs-core';
import {HttpTransport, HttpResponseError} from './files/transport';
import type {RemoteConnection} from './files/index';

/** Operating-system resources and identity-scoped activity; never historical session totals. */
export interface CellsNodeStatus {
    version: 1;
    sampledAt: number;
    scope: 'system';
    cpu: {cores: number; usagePercent: number | null; loadAverage: number[]} | null;
    memory: {totalBytes: number; availableBytes: number} | null;
    exports: Array<{alias: string; totalBytes: number | null; availableBytes: number | null}>;
    harness: {activeSessions: number | null; loadedRuntimes: number};
}

export async function readNodeStatus(connection: Omit<RemoteConnection,'alias'>,
    credential: (ref:string)=>Promise<string>, fetch:typeof globalThis.fetch, options?:OperationOptions):Promise<CellsNodeStatus> {
    const transport = new HttpTransport({...connection,credential:()=>credential(connection.credentialRef),fetch,timeoutMs:2500});
    try {
        return validate(await transport.json<unknown>('v1/node/status',{},options,128*1024));
    } catch (error) {
        if (error instanceof HttpResponseError && error.status === 404) throw new FSError('ECAPABILITY','Node statistics are not supported');
        throw error;
    } finally { transport.close(); }
}

function validate(value:unknown):CellsNodeStatus {
    const v=value as CellsNodeStatus;
    const count=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
    const nullable=(n:unknown)=>n===null||count(n);
    if (!v || v.version!==1 || v.scope!=='system' || !count(v.sampledAt)
        || !Array.isArray(v.exports) || v.exports.length>256
        || v.exports.some(e=>!e || typeof e.alias!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(e.alias) || !nullable(e.totalBytes)||!nullable(e.availableBytes))
        || !v.harness || !nullable(v.harness.activeSessions)||!count(v.harness.loadedRuntimes)) throw invalid();
    if (v.memory!==null && (!v.memory||!count(v.memory.totalBytes)||!count(v.memory.availableBytes)||v.memory.availableBytes>v.memory.totalBytes)) throw invalid();
    if (v.cpu!==null && (!v.cpu||!count(v.cpu.cores)||!Array.isArray(v.cpu.loadAverage)||v.cpu.loadAverage.length!==3
        || v.cpu.loadAverage.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0)
        || !(v.cpu.usagePercent===null||typeof v.cpu.usagePercent==='number'&&Number.isFinite(v.cpu.usagePercent)&&v.cpu.usagePercent>=0&&v.cpu.usagePercent<=100))) throw invalid();
    return v;
}
function invalid(){return new FSError('EIO','Invalid Cells node statistics','protocol');}
