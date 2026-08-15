import { Buffer } from 'node:buffer';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { mapWithConcurrency } from '../../../../shared/node/concurrency';
import type { AgentActivityState } from '../../../../shared/types';
import type {
    AgentEnvironment,
    AgentProviderDescriptor,
    AgentSnapshotContext,
    LocalAgentState,
} from '../../contract';
import { canonicalPath } from '../../contract';
import { claudeHookAdapter } from './hooks';

interface ClaudeSessionMetadata {
    cwd?: unknown;
    name?: unknown;
    sessionId?: unknown;
    startedAt?: unknown;
    status?: unknown;
    updatedAt?: unknown;
}

const MAX_CLAUDE_METADATA_BYTES = 128 * 1024;
const MAX_CLAUDE_METADATA_FILES = 512;
const MAX_CONCURRENT_CLAUDE_READS = 8;

async function readMetadata(path: string): Promise<ClaudeSessionMetadata | undefined> {
    const handle = await open(path, 'r');
    try {
        const stats = await handle.stat();
        if (stats.size > MAX_CLAUDE_METADATA_BYTES) return undefined;
        const buffer = Buffer.allocUnsafe(MAX_CLAUDE_METADATA_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_CLAUDE_METADATA_BYTES) return undefined;
        return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as ClaudeSessionMetadata;
    } finally {
        await handle.close();
    }
}

function timestamp(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Date.parse(value) || 0;
    return 0;
}

function sessionStartedAt(metadata: ClaudeSessionMetadata): number {
    return timestamp(metadata.startedAt) || timestamp(metadata.updatedAt);
}

function claudeStatus(value: unknown): AgentActivityState | undefined {
    if (value === 'busy') return 'running';
    if (value === 'idle') return 'waiting';
    if (value === 'completed' || value === 'failed') return value;
    return undefined;
}

/**
Reads only Claude Code's compact live-session metadata, never project transcripts.
 */
async function readClaudeState(
    context: AgentSnapshotContext,
    configDirectory: string,
): Promise<LocalAgentState | undefined> {
    const directory = join(configDirectory, 'sessions');
    let names: string[];
    try {
        names = [];
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            names.push(entry.name);
            if (names.length === MAX_CLAUDE_METADATA_FILES) break;
        }
    } catch {
        return undefined;
    }
    const requestedRoot = await canonicalPath(context.rootPath);
    const excludedSessionIds = new Set(context.excludedAgentSessionIds);
    const matches = await mapWithConcurrency(names, MAX_CONCURRENT_CLAUDE_READS, async (name) => {
        try {
            const metadata = await readMetadata(join(directory, name));
            if (!metadata) return;
            if (typeof metadata.cwd !== 'string') return;
            if ((await canonicalPath(metadata.cwd)) !== requestedRoot) return;
            if (context.agentSessionId && metadata.sessionId !== context.agentSessionId) return;
            if (
                !context.agentSessionId &&
                typeof metadata.sessionId === 'string' &&
                excludedSessionIds.has(metadata.sessionId)
            ) {
                return;
            }
            if (
                !context.agentSessionId &&
                context.startedAt &&
                sessionStartedAt(metadata) < context.startedAt
            ) {
                return;
            }
            return metadata;
        } catch {
            return;
        }
    });
    let latest: ClaudeSessionMetadata | undefined;
    for (const metadata of matches) {
        if (!metadata) continue;
        const isPreferred =
            !context.agentSessionId && context.startedAt
                ? sessionStartedAt(metadata) < sessionStartedAt(latest ?? {})
                : timestamp(metadata.updatedAt) > timestamp(latest?.updatedAt);
        if (!latest || isPreferred) latest = metadata;
    }
    if (!latest) return undefined;
    /**
     * A resumed process can briefly expose the previous turn's terminal status. Keep its identity
     *  and title, but do not publish attention until Claude updates metadata in this generation.
     */
    const isStatusIsCurrentGeneration =
        !context.startedAt || timestamp(latest.updatedAt) >= context.startedAt;
    return {
        sessionId: typeof latest.sessionId === 'string' ? latest.sessionId : undefined,
        status: isStatusIsCurrentGeneration ? claudeStatus(latest.status) : undefined,
        title:
            typeof latest.name === 'string' && latest.name.trim() ? latest.name.trim() : undefined,
    };
}

/**
Resolves Claude Code's config directory from generic environment inputs, honoring its override var.
 */
function resolveClaudeConfigDirectory(environment: AgentEnvironment): string {
    return environment.variables.CLAUDE_CONFIG_DIR || join(environment.homeDirectory, '.claude');
}

export const claudeProvider: AgentProviderDescriptor = {
    hooks: claudeHookAdapter,
    id: 'claude',
    readState: (context, environment) =>
        readClaudeState(context, resolveClaudeConfigDirectory(environment)),
};
