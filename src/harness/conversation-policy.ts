import type {HarnessClient, HarnessProfile, HarnessSession} from './contracts';
import type {HarnessConversationActions} from './conversation-snapshot';
import type {HarnessObservation} from './state';
import {harnessArchiveAllowed} from './state';

/** Runtime facts are inputs, never a second persisted Session state machine. */
export interface ConversationPolicyFacts {
    session?: HarnessSession;
    capabilities: HarnessProfile['capabilities'];
    client: Pick<HarnessClient, 'queryCommand' | 'steer' | 'fork' | 'delete' | 'rename' | 'archive'>;
    observation: HarnessObservation;
    loaded: boolean; writable: boolean; closed: boolean; deleted: boolean;
    busy: boolean; pending: boolean; pendingOperation?: string;
    navigating: boolean; forking: boolean; durable: boolean;
    controlBlocked: boolean; resultBlocked: boolean; commandRunning: boolean;
    queueLength: number; hasMessages: boolean; turnCompleted: boolean; canInterrupt: boolean;
    requests: readonly {id: string | number; kind: string}[]; respondingIds: readonly (string | number)[];
}

/** Admission is durable storage eligibility; dispatch additionally requires fresh execution evidence. */
function policyGates(facts: ConversationPolicyFacts) {
    const {session, observation} = facts;
    const available = observation.connection === 'online' && !observation.stale;
    const authorized = !facts.deleted && !facts.closed && facts.writable && observation.connection === 'online';
    const ready = authorized && facts.loaded && !facts.busy && !facts.pending;
    const dispatch = ready && !facts.controlBlocked && !facts.resultBlocked;
    const inactive = !['running', 'waiting-approval', 'waiting-input'].includes(observation.execution);
    const settled = inactive && !facts.commandRunning && !observation.receiptUnknown
        && !facts.requests.length && !session?.archived && !facts.navigating;
    const queue = facts.loaded && facts.writable && !facts.closed && !facts.deleted && !session?.archived
        && !facts.navigating && !facts.forking && facts.pendingOperation !== 'fork' && facts.durable
        && !!session && (!!session.owned || facts.capabilities.resume);
    return {available, authorized, ready, dispatch, settled, queue,
        manageable: dispatch && available && !!session && !facts.queueLength};
}

/** Derive permissions from independent lifecycle, observation and admission facts. */
export function conversationPolicy(facts: ConversationPolicyFacts): HarnessConversationActions & {canQueue: boolean} {
    const {session, observation, capabilities, client} = facts, gates = policyGates(facts);
    const resumable = !!session?.resumable && (!!session.owned || capabilities.resume);
    return {
        ...managementActions(facts, gates), canQueue: gates.queue,
        canQueryCommand: facts.loaded && !facts.closed && !facts.deleted && !facts.navigating
            && !!session && !!capabilities.commandQueries && !!client.queryCommand,
        canCommand: gates.ready && gates.available && !observation.refreshError && !!session && !session.archived && !!capabilities.slashCommands,
        canSteer: gates.dispatch && gates.available && facts.durable && !!session?.owned && !!session.activeTurnId
            && !session.archived && !facts.navigating && !!capabilities.steer && !!client.steer && !facts.turnCompleted,
        canSend: gates.dispatch && gates.settled && !observation.refreshError
            && (!session && capabilities.create || gates.available && resumable),
        canInterrupt: gates.authorized && facts.loaded && gates.available && !facts.navigating && facts.pendingOperation !== 'interrupt'
            && !!session?.owned && !!session.activeTurnId && session.interruptible !== false && capabilities.interrupt
            && !facts.turnCompleted && facts.canInterrupt,
        canRespond: gates.authorized && gates.available && facts.pendingOperation !== 'respond' && !!session?.owned && capabilities.interactions
            && facts.requests.some(request => request.kind !== 'unsupported' && !facts.respondingIds.includes(request.id)),
    };
}

function managementActions(facts: ConversationPolicyFacts, gates: ReturnType<typeof policyGates>) {
    const {session, observation, capabilities, client} = facts;
    const removable = observation.execution === 'idle' && !!session?.owned || !!session?.archived && session.status === 'notLoaded';
    return {
        canFork: gates.manageable && gates.settled && facts.hasMessages && !!client.fork && !!capabilities.fork && session?.forkable !== false,
        canDelete: gates.manageable && removable && !!client.delete && !!capabilities.delete,
        canRename: gates.ready && gates.available && !!session && !facts.navigating && !!client.rename && !!capabilities.rename,
        canArchive: gates.manageable && harnessArchiveAllowed(session) && !!client.archive && !!capabilities.archive,
        canUnarchive: gates.manageable && !!session?.archived && !!client.archive && !!capabilities.unarchive,
    };
}
