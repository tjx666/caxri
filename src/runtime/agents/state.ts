import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { AgentActivityState, ProcessState } from '../../shared/types';

export interface AgentSnapshotContext {
    /** Keeps repeated probes bound to the Agent session already correlated with this Terminal. */
    agentSessionId?: string;
    /** Keeps concurrent unbound Terminals in one Project from sharing a metadata probe. */
    correlationId?: string;
    /** Prevents an unbound Terminal from claiming an Agent session already owned or restarted. */
    excludedAgentSessionIds?: readonly string[];
    processState?: ProcessState;
    rootPath: string;
    /** Rejects same-directory Agent sessions that existed before this Terminal process started. */
    startedAt?: number;
}

export interface LocalAgentState {
    sessionId?: string;
    status?: AgentActivityState;
    title?: string;
    usage?: Array<{ label: string; value: string }>;
}

export interface AgentStateLocations {
    claudeConfigDirectory: string;
    codexStateDirectories: string[];
}

export function defaultAgentStateLocations(
    environment: NodeJS.ProcessEnv = process.env,
): AgentStateLocations {
    const home = homedir();
    const codexHome = environment.CODEX_HOME || join(home, '.codex');
    const sqliteHome = environment.CODEX_SQLITE_HOME;
    return {
        claudeConfigDirectory: environment.CLAUDE_CONFIG_DIR || join(home, '.claude'),
        codexStateDirectories: [
            ...(sqliteHome ? [resolve(sqliteHome)] : []),
            join(codexHome, 'sqlite'),
            codexHome,
        ],
    };
}

export function processStateToAgentActivity(state?: ProcessState): AgentActivityState {
    if (state === 'running' || state === 'starting') return 'running';
    if (state === 'failed' || state === 'dead') return 'failed';
    if (state === 'stopped') return 'completed';
    return 'unknown';
}

/** Compares Agent-recorded working directories against a Project root without failing on removal. */
export async function canonicalPath(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return resolve(path);
    }
}
