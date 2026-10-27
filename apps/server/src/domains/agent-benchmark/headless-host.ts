import type {
    AgentChatPatchOperation,
    AgentChatSnapshot,
    AgentChatTurn,
    AgentLaunchSettings,
} from '@caxri/protocol';
import { applyAgentChatOperation, emptyAgentChatSnapshot } from '@caxri/protocol';

import type { AgentChatExit, AgentChatSessionHost, prepareChatLaunch } from '../agent-chat';
import type { HeadlessTurnDependencies } from './headless-turn';

export interface HeadlessHostEvents {
    /**
     * Runs after each batch of operations reached the in-memory projection.
     */
    applied?(operations: readonly AgentChatPatchOperation[]): void;
    turnFinished?(status: AgentChatTurn['status']): void;
    exited?(exit: AgentChatExit): void;
}

export interface HeadlessHost {
    host: AgentChatSessionHost;
    snapshot(): AgentChatSnapshot;
    agentSessionId(): string | undefined;
}

/**
 * An {@link AgentChatSessionHost} with no Chat service behind it: the projection lives in memory, nothing is persisted
 * or published, and the callbacks a Chat Terminal needs (permission saves, lifecycle delivery, transcripts for resume)
 * do nothing. A Benchmark never resumes, rewinds, or forks, so none of them is reached.
 */
export function createHeadlessHost(
    id: string,
    prepared: Awaited<ReturnType<typeof prepareChatLaunch>>,
    launch: AgentLaunchSettings,
    dependencies: HeadlessTurnDependencies,
    events: HeadlessHostEvents = {},
): HeadlessHost {
    let snapshot = emptyAgentChatSnapshot(id);
    let agentSessionId: string | undefined;
    const observe = (event: { agentSessionId?: string }) => {
        if (event.agentSessionId) agentSessionId ??= event.agentSessionId;
    };
    const host: AgentChatSessionHost = {
        terminalId: id,
        cwd: prepared.cwd,
        executable: prepared.executable,
        environment: prepared.environment,
        launch,
        isRealAgentE2E: prepared.isRealAgentE2E,
        permission: { planMode: false },
        clientVersion: dependencies.clientVersion,
        spawnProcess: dependencies.spawnProcess,
        read: () => snapshot,
        apply: (operations) => {
            for (const operation of operations)
                snapshot = applyAgentChatOperation(snapshot, operation);
            events.applied?.(operations);
        },
        applyTask: () => {},
        readTask: () => {},
        lifecycle: observe,
        observeLifecycle: (event) => {
            observe(event);
            return Promise.resolve();
        },
        onSessionBound: (boundId) => {
            agentSessionId = boundId;
        },
        onTurnFinished: (status) => events.turnFinished?.(status),
        onPermissionChanged: () => {},
        onProtocolRejected: () => {},
        onDeliveryChecked: () => {},
        onProviderNotice: () => {},
        onForkReleaseFailed: () => {},
        onExit: (exit) => events.exited?.(exit),
        readTranscript: () => Promise.resolve(undefined),
    };
    return { host, snapshot: () => snapshot, agentSessionId: () => agentSessionId };
}
