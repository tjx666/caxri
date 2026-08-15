import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';

import type { AgentProvider } from '../../shared/agents';
import type { AgentActivityState, ProcessState } from '../../shared/types';
import type { AgentHookAdapter } from './hooks/contract';

export interface AgentSnapshotContext {
    /**
    Keeps repeated probes bound to the Agent session already correlated with this Terminal.
     */
    agentSessionId?: string;
    /**
    Keeps concurrent unbound Terminals in one Project from sharing a metadata probe.
     */
    correlationId?: string;
    /**
    Prevents an unbound Terminal from claiming an Agent session already owned or restarted.
     */
    excludedAgentSessionIds?: readonly string[];
    processState?: ProcessState;
    rootPath: string;
    /**
    Rejects same-directory Agent sessions that existed before this Terminal process started.
     */
    startedAt?: number;
}

export interface LocalAgentState {
    sessionId?: string;
    status?: AgentActivityState;
    title?: string;
    usage?: Array<{ label: string; value: string }>;
}

/**
 * Provider-agnostic inputs every `AgentProviderDescriptor` may consult to locate its own on-disk
 * state. This is intentionally generic (home directory, environment variables) so no provider-specific
 * field ever needs to live here; each provider module derives its own directories from these inputs.
 */
export interface AgentEnvironment {
    homeDirectory: string;
    variables: NodeJS.ProcessEnv;
}

export function defaultAgentEnvironment(
    variables: NodeJS.ProcessEnv = process.env,
): AgentEnvironment {
    return { homeDirectory: homedir(), variables };
}

/**
 * One self-contained descriptor per Agent provider. `displayName` and `executableName` live in the
 * shared catalog (`src/shared/agents.ts`); this interface only carries provider-specific behavior
 * so `service.ts`, `discovery.ts`, and `coordinator.ts` can iterate providers instead of hard-coding
 * a `claude`/`codex` branch each. Provider-local state reads stay pure, and an optional hook adapter
 * describes only that provider's configuration representation; generic Runtime code owns every
 * filesystem mutation, bridge process, and lifecycle signal.
 */
export interface AgentProviderDescriptor {
    hooks?: AgentHookAdapter;
    id: AgentProvider;
    readState(
        context: AgentSnapshotContext,
        environment: AgentEnvironment,
    ): Promise<LocalAgentState | undefined>;
}

export function processStateToAgentActivity(state?: ProcessState): AgentActivityState {
    if (state === 'running' || state === 'starting') return 'running';
    if (state === 'failed' || state === 'dead') return 'failed';
    if (state === 'stopped') return 'completed';
    return 'unknown';
}

/**
Compares Agent-recorded working directories against a Project root without failing on removal.
 */
export async function canonicalPath(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return resolve(path);
    }
}
