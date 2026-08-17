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
    nameSource?: unknown;
    sessionId?: unknown;
    startedAt?: unknown;
    status?: unknown;
    updatedAt?: unknown;
}

const MAX_CLAUDE_METADATA_BYTES = 128 * 1024;
const MAX_CLAUDE_METADATA_FILES = 512;
const MAX_CONCURRENT_CLAUDE_READS = 8;
const MAX_TRANSCRIPT_SCAN_BYTES_PER_READ = 4 * 1024 * 1024;
const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_TITLE_CACHES = 64;

interface TranscriptTitleCache {
    /**
     * Byte offset of the first unconsumed transcript byte; scans resume here on the next poll.
     */
    offset: number;
    title?: string;
}

/**
 * Incremental per-transcript scan state so the frequent agent-metadata polls only read appended bytes instead of
 * rescanning multi-megabyte transcripts on every refresh.
 */
const transcriptTitleCaches = new Map<string, TranscriptTitleCache>();

/**
 * Mirrors Claude Code's own project-directory encoding of a session cwd (every non-alphanumeric character becomes `-`).
 */
function claudeProjectDirectoryName(cwd: string): string {
    return cwd.replaceAll(/[^a-z0-9]/gi, '-');
}

function extractAiTitle(line: string): string | undefined {
    if (!line.includes('"aiTitle"')) return undefined;
    try {
        const record = JSON.parse(line) as { aiTitle?: unknown; type?: unknown };
        if (record.type !== 'ai-title' || typeof record.aiTitle !== 'string') return undefined;
        return record.aiTitle.trim() || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Reads the AI-generated title (`{"type":"ai-title"}` records) from the matched session's own transcript. Claude Code
 * keeps this title only in the project transcript — the live-session metadata `name` is merely derived from the working
 * directory — so this is the only source for the human-meaningful session title.
 */
async function readTranscriptTitle(
    configDirectory: string,
    cwd: string,
    sessionId: string,
): Promise<string | undefined> {
    const path = join(
        configDirectory,
        'projects',
        claudeProjectDirectoryName(cwd),
        `${sessionId}.jsonl`,
    );
    let cache = transcriptTitleCaches.get(path);
    if (!cache) {
        cache = { offset: 0 };
        transcriptTitleCaches.set(path, cache);
        if (transcriptTitleCaches.size > MAX_TRANSCRIPT_TITLE_CACHES) {
            const oldest = transcriptTitleCaches.keys().next().value;
            if (oldest !== undefined) transcriptTitleCaches.delete(oldest);
        }
    }
    try {
        const handle = await open(path, 'r');
        try {
            const stats = await handle.stat();
            if (stats.size < cache.offset) Object.assign(cache, { offset: 0, title: undefined });
            const chunk = Buffer.allocUnsafe(TRANSCRIPT_READ_CHUNK_BYTES);
            let scanned = 0;
            let remainder = Buffer.alloc(0);
            while (
                cache.offset + remainder.length < stats.size &&
                scanned < MAX_TRANSCRIPT_SCAN_BYTES_PER_READ
            ) {
                // eslint-disable-next-line no-await-in-loop -- chunks of one file must be read sequentially
                const { bytesRead } = await handle.read(
                    chunk,
                    0,
                    chunk.length,
                    cache.offset + remainder.length,
                );
                if (bytesRead <= 0) break;
                scanned += bytesRead;
                const combined = Buffer.concat([remainder, chunk.subarray(0, bytesRead)]);
                const lastNewline = combined.lastIndexOf(0x0a);
                if (lastNewline === -1) {
                    remainder = combined;
                    continue;
                }
                for (const line of combined.subarray(0, lastNewline).toString('utf8').split('\n')) {
                    const title = extractAiTitle(line);
                    if (title) cache.title = title;
                }
                remainder = combined.subarray(lastNewline + 1);
                cache.offset += lastNewline + 1;
            }
            /**
             * The final line may lack a trailing newline; parse it without consuming so a later append re-reads it as a
             * complete line.
             */
            const trailingTitle = extractAiTitle(remainder.toString('utf8'));
            if (trailingTitle) cache.title = trailingTitle;
        } finally {
            await handle.close();
        }
    } catch {
        /**
         * A missing or unreadable transcript is a normal capability miss; keep any cached title.
         */
    }
    return cache.title;
}

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
 * Resolves the display title for a matched session. An explicitly set live-session name wins; otherwise the
 * transcript's AI-generated title is preferred over the directory-derived name.
 */
async function resolveClaudeTitle(
    metadata: ClaudeSessionMetadata,
    configDirectory: string,
): Promise<string | undefined> {
    const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
    if (name && metadata.nameSource !== 'derived') return name;
    if (typeof metadata.cwd === 'string' && typeof metadata.sessionId === 'string') {
        const aiTitle = await readTranscriptTitle(
            configDirectory,
            metadata.cwd,
            metadata.sessionId,
        );
        if (aiTitle) return aiTitle;
    }
    return name || undefined;
}

/**
 * Reads Claude Code's compact live-session metadata, plus a bounded incremental scan of the matched session's own
 * transcript for its AI-generated title (the live metadata `name` is only derived from the working directory).
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
     * A resumed process can briefly expose the previous turn's terminal status. Keep its identity and title, but do not
     * publish attention until Claude updates metadata in this generation.
     */
    const isStatusIsCurrentGeneration =
        !context.startedAt || timestamp(latest.updatedAt) >= context.startedAt;
    return {
        sessionId: typeof latest.sessionId === 'string' ? latest.sessionId : undefined,
        status: isStatusIsCurrentGeneration ? claudeStatus(latest.status) : undefined,
        title: await resolveClaudeTitle(latest, configDirectory),
    };
}

/**
 * Resolves Claude Code's config directory from generic environment inputs, honoring its override var.
 */
function resolveClaudeConfigDirectory(environment: AgentEnvironment): string {
    // `||` (not `??`) is deliberate: `CLAUDE_CONFIG_DIR=''` is not a usable override path either.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string is not a valid override path either
    return environment.variables.CLAUDE_CONFIG_DIR || join(environment.homeDirectory, '.claude');
}

export const claudeProvider: AgentProviderDescriptor = {
    hooks: claudeHookAdapter,
    id: 'claude',
    readState: (context, environment) =>
        readClaudeState(context, resolveClaudeConfigDirectory(environment)),
};
