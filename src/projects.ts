import {validateAuthorization, validateProjectCapabilities, type RemoteAuthorization, type RemoteProjectCapabilities} from './authorization';
import { MCPDirectorySyncClient, type DirectorySyncClient } from './directory-sync';
import { FSError, type OperationOptions } from '@nestos/vfs-core';
import { CellsHarnessClient } from './harness/client';
import { CellsRpc } from './harness/rpc';
import type { HarnessClient } from './harness/contracts';
import { validateFileSearch, validateSearchDirectory, type FileSearchQuery, type FileSearchResult } from './search';

export interface ProjectEnvironment { profile: string | null; variables: Record<string, string> }
export interface ProjectExecutionSettings { execution: ProjectEnvironment; profiles: Array<{id: string; name: string; user: string | null}> }
export interface ProjectMount { alias: string; path: string; at: string; access: 'ro' | 'rw' }
export interface RemoteProject {
    authorization?: RemoteAuthorization; capabilities?: RemoteProjectCapabilities;
    id: string; name: string; alias: string; path: string; access: 'ro' | 'rw'; revision: number; mounts: ProjectMount[];
}
export interface RegisterProject { id?: string; name: string; alias: string; path: string; access: 'ro' | 'rw'; mounts?: ProjectMount[]; createDirectory?: boolean }
export interface ProjectProcess { state: string; stdout: string; stderr: string; code: number | null; error: string | null; truncated: boolean }
export interface ProjectClient {
    channel?(project: RemoteProject, operation: 'open' | 'messages' | 'close' | 'requests' | 'respond' | 'current' | 'acknowledge', input: Record<string, unknown>, options?: OperationOptions): Promise<unknown>;
    executionSettings?(project: RemoteProject, options?: OperationOptions): Promise<ProjectExecutionSettings>;
    setExecution?(project: RemoteProject, execution: ProjectEnvironment, options?: OperationOptions): Promise<RemoteProject>;
    search?(project: RemoteProject, query: FileSearchQuery, options?: OperationOptions): Promise<FileSearchResult>;
    roots(options?: OperationOptions): Promise<{ roots: Array<{alias: string; access: 'ro' | 'rw'}>; execution: boolean; backend: string }>;
    list(options?: OperationOptions): Promise<RemoteProject[]>;
    read(id: string, options?: OperationOptions): Promise<RemoteProject>;
    register(input: RegisterProject, options?: OperationOptions): Promise<RemoteProject>;
    configure(project: RemoteProject, name: string, mounts: ProjectMount[], options?: OperationOptions): Promise<RemoteProject>;
    remount?(project: RemoteProject, access: 'ro' | 'rw', options?: OperationOptions): Promise<RemoteProject>;
    forget(project: RemoteProject, options?: OperationOptions): Promise<void>;
    exec(project: RemoteProject, input: {command: string; args: string[]; cwd?: string; timeoutMs?: number; readOnly?: boolean; epoch: string; requestId: string}, options?: OperationOptions): Promise<ProjectProcess>;
    harness(project: RemoteProject, options?: {readOnly?: boolean}): HarnessClient;
    directorySync(): DirectorySyncClient;
    close(): Promise<void>;
}
export class CellsProjectClient implements ProjectClient {
    channel(project: RemoteProject, operation: 'open' | 'messages' | 'close' | 'requests' | 'respond' | 'current' | 'acknowledge', input: Record<string, unknown>, options?: OperationOptions): Promise<unknown> {
        return this.rpc.call('project_channel_' + operation, {...input, projectId: project.id, revision: project.revision}, options);
    }
    constructor(private readonly rpc: CellsRpc) {}
    async executionSettings(project: RemoteProject, options?: OperationOptions): Promise<ProjectExecutionSettings> {
        const meta = await this.rpc.metadata?.(options);
        const capability = meta as {projectExecutionEnvironment?: boolean} | undefined;
        if (capability?.projectExecutionEnvironment !== true) throw new FSError('ECAPABILITY', 'Node execution settings require a newer server');
        const value = await this.rpc.call('project_execution', {projectId: project.id}, options) as ProjectExecutionSettings;
        if (!value || !Array.isArray(value.profiles) || value.profiles.some(p => !p || typeof p.id !== 'string' || typeof p.name !== 'string' || p.user !== null && typeof p.user !== 'string')) throw new FSError('EIO', 'Invalid execution profiles');
        validateEnvironment(value.execution);
        return value;
    }
    async setExecution(project: RemoteProject, execution: ProjectEnvironment, options?: OperationOptions) {
        execution = structuredClone(execution);
        validateEnvironment(execution);
        await this.executionSettings(project, options);
        return this.project('project_set_execution', {projectId: project.id, revision: project.revision, execution}, options);
    }
    async search(project: RemoteProject, query: FileSearchQuery, options?: OperationOptions) {
        validateSearchDirectory(query.directory);
        const meta = await this.rpc.metadata?.(options);
        const capabilities = meta as {fileSearch?: boolean; fileSearchVersion?: number; searchKeywords?: boolean} | undefined;
        if (capabilities?.fileSearch === false) throw new FSError('ECAPABILITY', 'Server file search unavailable');
        if (/[^\S\r\n]/u.test(query.query) && capabilities?.searchKeywords !== true)
            throw new FSError('ECAPABILITY', 'Keyword search requires a newer server');
        if (query.mode === 'name' || query.directory) {
            if (typeof capabilities?.fileSearchVersion !== 'number' || !Number.isSafeInteger(capabilities.fileSearchVersion) || capabilities.fileSearchVersion < 2) throw new FSError('ECAPABILITY', 'Scoped file search requires a newer server');
        }
        return validateFileSearch(await this.rpc.call('project_search', {projectId: project.id, revision: project.revision, ...query}, options));
    }
    async roots(options?: OperationOptions) {
        const value = await this.rpc.call('project_roots', {}, options) as Awaited<ReturnType<ProjectClient['roots']>>;
        if (!value || !Array.isArray(value.roots) || typeof value.execution !== 'boolean' || typeof value.backend !== 'string'
            || value.roots.some(root => !root || typeof root.alias !== 'string' || !['ro','rw'].includes(root.access))) throw new FSError('EIO','Invalid project roots');
        return value;
    }
    async list(options?: OperationOptions) {
        const value = await this.rpc.call('project_list',{},options) as {projects?: unknown[]};
        if (!Array.isArray(value?.projects)) throw new FSError('EIO','Invalid project list');
        return value.projects.map(validateProject);
    }
    read(id: string, options?: OperationOptions) { return this.project('project_read',{projectId:id},options); }
    register(input: RegisterProject, options?: OperationOptions) { return this.project('project_register',input,options); }
    configure(project: RemoteProject, name: string, mounts: ProjectMount[], options?: OperationOptions) {
        return this.project('project_configure',{projectId:project.id,revision:project.revision,name,mounts},options);
    }
    remount(project: RemoteProject, access: 'ro' | 'rw', options?: OperationOptions) {
        return this.project('project_remount', {projectId: project.id, revision: project.revision, access}, options);
    }
    async forget(project: RemoteProject, options?: OperationOptions) {
        const value=await this.rpc.call('project_forget',{projectId:project.id,revision:project.revision},options) as {forgotten?: string};
        if (value?.forgotten!==project.id) throw new FSError('EIO','Invalid project removal');
    }
    async exec(project: RemoteProject, input: Parameters<ProjectClient['exec']>[1], options?: OperationOptions) {
        const value = await this.rpc.call('project_exec',{projectId:project.id,revision:project.revision,...input},options) as {process?: ProjectProcess};
        if (!value?.process || typeof value.process.state !== 'string' || typeof value.process.stdout !== 'string' || typeof value.process.stderr !== 'string') throw new FSError('EIO','Invalid project process');
        return value.process;
    }
    harness(project: RemoteProject, options?: {readOnly?: boolean}) { return new CellsHarnessClient(this.rpc,{projectId:project.id,revision:project.revision,capabilities:project.capabilities,...options}); }
    private async project(name: string, args: object, options?: OperationOptions) {
        const value = await this.rpc.call(name,args,options) as {project?: unknown}; return validateProject(value?.project);
    }
    directorySync() { return new MCPDirectorySyncClient(this.rpc); }
    close() { return this.rpc.close(); }
}
function validateProject(value: unknown): RemoteProject {
    const project = value as RemoteProject | undefined;
    if (!project || typeof project.id !== 'string' || typeof project.name !== 'string' || typeof project.alias !== 'string'
        || typeof project.path !== 'string' || !['ro','rw'].includes(project.access) || !Number.isSafeInteger(project.revision)
        || project.revision < 1 || !Array.isArray(project.mounts)) throw new FSError('EIO','Invalid project descriptor');
    if (project.mounts.some(mount => !mount || typeof mount.alias !== 'string' || typeof mount.path !== 'string'
        || typeof mount.at !== 'string' || !['ro','rw'].includes(mount.access))) throw new FSError('EIO','Invalid project mount');
    return {...project, authorization: validateAuthorization(project.authorization), capabilities: validateProjectCapabilities(project.capabilities)};
}

function validateEnvironment(value: ProjectEnvironment): void {
    if (!value || value.profile !== null && typeof value.profile !== 'string' || !value.variables || typeof value.variables !== 'object' || Array.isArray(value.variables)
        || Object.entries(value.variables).length > 64 || Object.entries(value.variables).some(([key, text]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof text !== 'string' || new TextEncoder().encode(text).length > 8192 || text.includes('\0')))
        throw new FSError('EINVAL', 'Invalid project execution environment');
}
