import type { AgentProvider } from '../../../shared/agents';
import type { AgentEnvironment } from '../contract';

export const agentLifecyclePhases = [
    'sessionIdentified',
    'turnStarted',
    'attentionRequested',
    'turnFinished',
    'shellToolFinished',
    'compactionStarted',
    'compactionFinished',
] as const;

export type AgentLifecyclePhase = (typeof agentLifecyclePhases)[number];

export interface AgentLifecycleSignal {
    /**
     * Provider-native session identifier from the hook payload, when the provider supplies one. Only this opaque id
     * crosses the boundary — prompt and response content never do — so a manual in-terminal resume can rebind the
     * Terminal to the session the Agent actually runs.
     */
    agentSessionId?: string;
    launchId: string;
    phase: AgentLifecyclePhase;
    provider: AgentProvider;
    terminalId: string;
}

export interface AgentHookBinding {
    event: string;
    matcher?: string;
    phase: AgentLifecyclePhase;
    reply?: 'emptyJson';
}

export interface AgentHookConfigTarget {
    id: string;
    path: string;
    writable: boolean;
}

export interface DesiredHookInstall {
    bridgePath: string;
    provider: AgentProvider;
    schemaVersion: number;
}

export type AgentHookDocuments = ReadonlyMap<string, string | undefined>;

export type AgentHookEntryStatus =
    | { kind: 'absent' }
    | { kind: 'current' }
    | { kind: 'stale'; installedSchema: number }
    | { kind: 'newer'; installedSchema: number }
    | { kind: 'drifted' }
    | { kind: 'conflict'; message: string }
    | { kind: 'unparseable'; message: string };

interface AgentHookInspection {
    status: AgentHookEntryStatus;
}

export interface AgentHookConfigEdit {
    source: string;
    targetId: string;
}

interface AgentHookSupport {
    phases: readonly AgentLifecyclePhase[];
    reason?: string;
    supported: boolean;
}

/**
 * Provider-owned, filesystem-free hook configuration behavior. The generic hook manager owns every read, lock, atomic
 * replace, read-back check, watcher, bridge, and socket operation.
 */
export interface AgentHookAdapter {
    readonly bindings: readonly AgentHookBinding[];
    readonly schemaVersion: number;
    configTargets(environment: AgentEnvironment): readonly AgentHookConfigTarget[];
    inspect(documents: AgentHookDocuments, desired: DesiredHookInstall): AgentHookInspection;
    remove(
        documents: AgentHookDocuments,
        desired: DesiredHookInstall,
    ): readonly AgentHookConfigEdit[];
    render(
        documents: AgentHookDocuments,
        desired: DesiredHookInstall,
    ): readonly AgentHookConfigEdit[];
    supports(cliVersion: string | undefined): AgentHookSupport;
}
