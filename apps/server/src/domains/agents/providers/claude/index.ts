import { Buffer } from 'node:buffer';
import { open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { AgentActivityState } from '@caxri/protocol';
import { mapWithConcurrency } from '@caxri/system';

import { runExternalCommand } from '../../../executables';
import type {
    AgentProviderDescriptor,
    AgentProviderSessionRenameContext,
    AgentSessionRenameResult,
    AgentSnapshotContext,
    LocalAgentState,
} from '../../contract';
import { canonicalPath, isOpaqueAgentSessionId, projectDirectories } from '../../contract';
import { AGENT_PASTE_SUMMARY_SYSTEM_INSTRUCTIONS } from '../../paste-summary-generation';
import {
    agentCommandEnvironment,
    assertAgentRenameVersion,
    throwAgentRenameError,
} from '../../rename';
import type { TranscriptScanCursor } from '../../transcript-scan';
import { scanTranscriptLines } from '../../transcript-scan';
import { claudeHookAdapter } from './hooks';
import { generateClaudeLowCostText } from './low-cost-generation';
import { claudeNaming } from './naming';
import {
    claudeTranscriptBaseRoot,
    claudeTranscriptPath,
    claudeTranscriptRoot,
    resolveClaudeConfigDirectory,
} from './paths';

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
const MAX_TRANSCRIPT_TITLE_CACHES = 64;
/**
 * Non-interactive `/rename` is the public write boundary. Repeating the same exact-session rename is idempotent on the
 * supported CLI line, while the parsed result remains authoritative if provider behavior changes.
 *
 * @see https://code.claude.com/docs/en/commands
 */
const CLAUDE_RENAME_MINIMUM_VERSION = '2.1.232';
const CLAUDE_RENAME_OUTPUT_BYTES = 64 * 1024;
const CLAUDE_RENAME_TIMEOUT_MS = 10_000;
const CLAUDE_RENAME_RESULT_PREFIX = 'Session renamed to:';

interface TranscriptTitleCache extends TranscriptScanCursor {
    title?: string;
}

interface ClaudeRenameResponse {
    is_error?: unknown;
    result?: unknown;
    session_id?: unknown;
    subtype?: unknown;
    type?: unknown;
}

function parseClaudeRenameResponse(
    stdout: string,
    expectedSessionId: string,
): AgentSessionRenameResult {
    let response: ClaudeRenameResponse;
    try {
        response = JSON.parse(stdout.trim()) as ClaudeRenameResponse;
    } catch {
        throw new Error('Claude Code returned invalid rename output');
    }
    if (
        response.type !== 'result' ||
        response.subtype !== 'success' ||
        response.is_error !== false ||
        response.session_id !== expectedSessionId ||
        typeof response.result !== 'string' ||
        !response.result.startsWith(CLAUDE_RENAME_RESULT_PREFIX)
    )
        throw new Error('Claude Code rejected the Session rename');
    const displayTitle = response.result.slice(CLAUDE_RENAME_RESULT_PREFIX.length).trim();
    if (!displayTitle) throw new Error('Claude Code returned an empty Session name');
    return { displayTitle };
}

export async function renameClaudeSession(
    context: AgentProviderSessionRenameContext,
): Promise<AgentSessionRenameResult> {
    assertAgentRenameVersion('claude', context.version, CLAUDE_RENAME_MINIMUM_VERSION);
    try {
        const { stdout } = await runExternalCommand(
            context.executable,
            [
                '--resume',
                context.agentSessionId,
                '--print',
                '--output-format',
                'json',
                `/rename ${context.displayTitle}`,
            ],
            {
                cwd: context.cwd,
                env: agentCommandEnvironment(context.environment),
                maxBuffer: CLAUDE_RENAME_OUTPUT_BYTES,
                signal: context.signal,
                timeout: CLAUDE_RENAME_TIMEOUT_MS,
            },
        );
        return parseClaudeRenameResponse(stdout, context.agentSessionId);
    } catch (error) {
        throwAgentRenameError('claude', error, context.signal);
    }
}

/**
 * Incremental per-transcript scan state so the frequent agent-metadata polls only read appended bytes instead of
 * rescanning multi-megabyte transcripts on every refresh.
 */
const transcriptTitleCaches = new Map<string, TranscriptTitleCache>();

function scanTranscriptLine(line: string, cache: TranscriptTitleCache): void {
    if (line.includes('"aiTitle"')) {
        try {
            const record = JSON.parse(line) as { aiTitle?: unknown; type?: unknown };
            if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
                const title = record.aiTitle.trim();
                if (title) cache.title = title;
            }
        } catch {
            /*
            Partial or malformed lines are skipped; a later append re-delivers them complete.
            */
        }
    }
}

/**
 * Reads only Claude Code's generated title from the matched Session transcript. Raw prompts are intentionally excluded
 * because this title also reaches Caxri persistence and native operating-system notifications.
 */
async function readTranscriptTitles(
    configDirectory: string,
    cwd: string,
    sessionId: string,
): Promise<TranscriptTitleCache> {
    const path = claudeTranscriptPath(configDirectory, cwd, sessionId);
    let cache = transcriptTitleCaches.get(path);
    if (!cache) {
        cache = { offset: 0 };
        transcriptTitleCaches.set(path, cache);
        if (transcriptTitleCaches.size > MAX_TRANSCRIPT_TITLE_CACHES) {
            const oldest = transcriptTitleCaches.keys().next().value;
            if (oldest !== undefined) transcriptTitleCaches.delete(oldest);
        }
    }
    if (!isOpaqueAgentSessionId(sessionId)) return cache;
    const titleCache = cache;
    await scanTranscriptLines(
        {
            baseRoot: claudeTranscriptBaseRoot(configDirectory),
            path,
            root: claudeTranscriptRoot(configDirectory, cwd),
        },
        titleCache,
        (line) => scanTranscriptLine(line, titleCache),
        { onReset: () => (titleCache.title = undefined) },
    );
    return cache;
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
 * Resolves the display title without ever promoting a raw prompt into Caxri persistence or an OS notification.
 */
async function resolveClaudeTitle(
    metadata: ClaudeSessionMetadata,
    configDirectory: string,
): Promise<string | undefined> {
    const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
    if (name && metadata.nameSource !== 'derived') return name;
    if (typeof metadata.cwd === 'string' && typeof metadata.sessionId === 'string') {
        const transcript = await readTranscriptTitles(
            configDirectory,
            metadata.cwd,
            metadata.sessionId,
        );
        if (transcript.title) return transcript.title;
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

export const claudeProvider: AgentProviderDescriptor = {
    actions: {
        roots: (context, environment) => {
            const configuredDirectory = environment.variables.CLAUDE_CONFIG_DIR;
            const configDirectory = resolve(
                configuredDirectory === undefined || configuredDirectory === ''
                    ? join(environment.homeDirectory, '.claude')
                    : configuredDirectory,
            );
            return [
                { directory: join(configDirectory, 'commands'), kind: 'commands', scope: 'global' },
                { directory: join(configDirectory, 'skills'), kind: 'skills', scope: 'global' },
                ...projectDirectories(context).flatMap((directory) => [
                    {
                        boundaryDirectory: context.projectRoot,
                        directory: join(directory, '.claude', 'commands'),
                        kind: 'commands' as const,
                        scope: 'project' as const,
                    },
                    {
                        boundaryDirectory: context.projectRoot,
                        directory: join(directory, '.claude', 'skills'),
                        kind: 'skills' as const,
                        scope: 'project' as const,
                    },
                ]),
            ];
        },
        commandInvocation: (relativeName) => `/${relativeName.replaceAll('/', ':')}`,
        skillInvocation: (name) => `/${name}`,
    },
    hooks: claudeHookAdapter,
    id: 'claude',
    naming: claudeNaming,
    pasteSummary: {
        summarize: (context) =>
            generateClaudeLowCostText(
                context,
                AGENT_PASTE_SUMMARY_SYSTEM_INSTRUCTIONS,
                'Long paste summary',
                10_000,
            ),
    },
    readState: (context, environment) =>
        readClaudeState(context, resolveClaudeConfigDirectory(environment)),
    renameSession: renameClaudeSession,
    resumeArguments: (agentSessionId) => ['--resume', agentSessionId],
    transcriptBaseRoot: (environment) =>
        claudeTranscriptBaseRoot(resolveClaudeConfigDirectory(environment)),
    transcriptPath: ({ agentSessionId, cwd }, environment) =>
        claudeTranscriptPath(resolveClaudeConfigDirectory(environment), cwd, agentSessionId),
    transcriptRoot: ({ cwd }, environment) =>
        claudeTranscriptRoot(resolveClaudeConfigDirectory(environment), cwd),
};
