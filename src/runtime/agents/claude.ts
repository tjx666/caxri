import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentActivityState } from '../../shared/types';
import { canonicalPath, type AgentSnapshotContext, type LocalAgentState } from './state';

interface ClaudeSessionMetadata {
    cwd?: unknown;
    name?: unknown;
    sessionId?: unknown;
    startedAt?: unknown;
    status?: unknown;
    updatedAt?: unknown;
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

/** Reads only Claude Code's compact live-session metadata, never project transcripts. */
export async function readClaudeState(
    context: AgentSnapshotContext,
    configDirectory: string,
): Promise<LocalAgentState | undefined> {
    const directory = join(configDirectory, 'sessions');
    let names: string[];
    try {
        names = (await readdir(directory, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => entry.name)
            .slice(0, 512);
    } catch {
        return undefined;
    }
    const requestedRoot = await canonicalPath(context.rootPath);
    const excludedSessionIds = new Set(context.excludedAgentSessionIds ?? []);
    const matches = await Promise.all(
        names.map(async (name) => {
            try {
                const source = await readFile(join(directory, name), 'utf8');
                if (source.length > 128 * 1024) return undefined;
                const metadata = JSON.parse(source) as ClaudeSessionMetadata;
                if (typeof metadata.cwd !== 'string') return undefined;
                if ((await canonicalPath(metadata.cwd)) !== requestedRoot) return undefined;
                if (context.agentSessionId && metadata.sessionId !== context.agentSessionId)
                    return undefined;
                if (
                    !context.agentSessionId &&
                    typeof metadata.sessionId === 'string' &&
                    excludedSessionIds.has(metadata.sessionId)
                ) {
                    return undefined;
                }
                if (
                    !context.agentSessionId &&
                    context.startedAt &&
                    sessionStartedAt(metadata) < context.startedAt
                ) {
                    return undefined;
                }
                return metadata;
            } catch {
                return undefined;
            }
        }),
    );
    const latest = matches
        .filter((value): value is ClaudeSessionMetadata => Boolean(value))
        .sort((left, right) =>
            !context.agentSessionId && context.startedAt
                ? sessionStartedAt(left) - sessionStartedAt(right)
                : timestamp(right.updatedAt) - timestamp(left.updatedAt),
        )[0];
    if (!latest) return undefined;
    return {
        sessionId: typeof latest.sessionId === 'string' ? latest.sessionId : undefined,
        status: claudeStatus(latest.status),
        title:
            typeof latest.name === 'string' && latest.name.trim() ? latest.name.trim() : undefined,
    };
}
