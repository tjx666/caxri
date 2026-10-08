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
import {
    agentCommandEnvironment,
    assertAgentRenameVersion,
    throwAgentRenameError,
} from '../../rename';
import { AGENT_TITLE_SYSTEM_INSTRUCTIONS } from '../../title-generation';
import type { TranscriptScanCursor } from '../../transcript-scan';
import { scanTranscriptLines } from '../../transcript-scan';
import { claudeDelegationAdapter } from './delegation';
import { claudeHookAdapter } from './hooks';
import { generateClaudeLowCostText } from './low-cost-generation';
import type { ClaudeSessionMetadata } from './metadata-cache';
import { claudeMetadataCacheCounters, readClaudeSessionMetadata } from './metadata-cache';
import {
    claudeTranscriptBaseRoot,
    claudeTranscriptPath,
    claudeTranscriptRoot,
    resolveClaudeConfigDirectory,
} from './paths';
import { appendClaudeTimelineRecord } from './timeline';

const MAX_TRANSCRIPT_TITLE_CACHES = 64;
/**
 * Non-interactive `/rename` is the public write boundary. Repeating the same exact-session rename is idempotent on the
 * supported CLI line, while the parsed result remains authoritative if provider behavior changes.
 *
 * @see https://code.claude.com/docs/en/commands
 */
const CLAUDE_RENAME_MINIMUM_VERSION = '2.1.232';
const CLAUDE_RENAME_OUTPUT_BYTES = 64 * 1024;
/**
 * The Renderer shows a manual rename before this call returns, so the limit only guards a hung CLI holding the
 * Session's rename queue, which also carries automatic naming. A cold `claude --resume` routinely takes ~5s.
 */
const CLAUDE_RENAME_TIMEOUT_MS = 60_000;
const CLAUDE_RENAME_RESULT_PREFIX = 'Session renamed to:';

interface TranscriptTitleCache extends TranscriptScanCursor {
    /**
     * Latest `ai-title` record: Claude Code's own generated title, re-appended after later turns.
     */
    aiTitle?: string;
    /**
     * Latest `custom-title` record: the `/rename` result, including Caxri's non-interactive manual rename.
     */
    customTitle?: string;
}

/**
 * Mirrors Claude Code's own resolution (`customTitle || aiTitle`). Claude Code keeps regenerating `ai-title` after
 * later turns, so a "last record wins" read let its generated title silently replace the `/rename` result and the
 * displayed title flapped between the two.
 */
function transcriptTitle(cache: TranscriptTitleCache): string | undefined {
    return cache.customTitle ?? cache.aiTitle;
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
                env: await agentCommandEnvironment(context.environment),
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

/**
 * Claude Code appends an `ai-title` record for its own generated title and a `custom-title` record for `/rename`,
 * including the non-interactive `/rename` Caxri issues for a manual Session rename. The live `sessions/<pid>.json`
 * metadata is owned by the interactive process and keeps its directory-derived `name` after an external rename, so the
 * transcript is the only place the renamed title can be read back from. The two record kinds are tracked separately
 * because a `custom-title` outranks any `ai-title` regardless of append order; see {@link transcriptTitle}.
 */
function scanTranscriptLine(line: string, cache: TranscriptTitleCache): void {
    if (!line.includes('"aiTitle"') && !line.includes('"customTitle"')) return;
    try {
        const record = JSON.parse(line) as {
            aiTitle?: unknown;
            customTitle?: unknown;
            type?: unknown;
        };
        if (record.type === 'ai-title') {
            if (typeof record.aiTitle !== 'string') return;
            const title = record.aiTitle.trim();
            if (title) cache.aiTitle = title;
        } else if (record.type === 'custom-title') {
            if (typeof record.customTitle !== 'string') return;
            const title = record.customTitle.trim();
            if (title) cache.customTitle = title;
        }
    } catch {
        /*
        Partial or malformed lines are skipped; a later append re-delivers them complete.
        */
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
        {
            onReset: () => {
                titleCache.aiTitle = undefined;
                titleCache.customTitle = undefined;
            },
        },
    );
    return cache;
}

function timestamp(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Date.parse(value) || 0;
    return 0;
}

/**
 * Ceiling on concurrent `realpath` calls while matching Claude's recorded working directories. Before this the fan-out
 * was an unbounded `Promise.all` over every recorded directory, which puts one libuv threadpool thread per entry behind
 * a probe that fires after every burst of PTY activity. Matches the read concurrency the metadata cache already uses.
 */
const MAX_CONCURRENT_CLAUDE_CWD_READS = 8;

function sessionStartedAt(metadata: ClaudeSessionMetadata): number {
    return timestamp(metadata.startedAt) || timestamp(metadata.updatedAt);
}

/**
 * Claude Code's `idle` means only "no turn is running right now": it is written at launch before any turn, after a turn
 * ends, and while the prompt sits empty. It is not evidence that the Agent is blocked on the user, so it must not map
 * to `waiting`: the PrimarySidebar renders a durable amber "needs attention" cue for a waiting Session that never
 * consults read state, which left every finished Session permanently marked. A genuinely blocked Agent reports itself
 * through the explicit `PermissionRequest` hook (`attentionRequested`), so nothing is lost by reading `idle` as the end
 * of a turn instead.
 */
function claudeStatus(value: unknown): AgentActivityState | undefined {
    if (value === 'busy') return 'running';
    if (value === 'idle') return 'completed';
    if (value === 'completed' || value === 'failed') return value;
    return undefined;
}

/**
 * Resolves the display title without ever promoting a raw prompt into Caxri persistence or an OS notification.
 *
 * A `derived` metadata name (`<directory>-xx`) is a placeholder Claude Code assigns before any real title exists. It is
 * never returned as a title: `decideAgentMetadataUpdate` would otherwise persist it over the title the last rename just
 * wrote, because the interactive process never refreshes its metadata `name` after an external `/rename`. Returning
 * `undefined` keeps the Session's current title instead.
 */
async function resolveClaudeTitle(
    metadata: ClaudeSessionMetadata,
    configDirectory: string,
): Promise<Pick<LocalAgentState, 'title' | 'titleSource'>> {
    const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
    if (typeof metadata.cwd === 'string' && typeof metadata.sessionId === 'string') {
        const transcript = await readTranscriptTitles(
            configDirectory,
            metadata.cwd,
            metadata.sessionId,
        );
        if (transcript.customTitle)
            return { title: transcript.customTitle, titleSource: 'explicit' };
        if (name && metadata.nameSource === 'user') return { title: name, titleSource: 'explicit' };
        const title = transcriptTitle(transcript);
        if (title) return { title, titleSource: 'automatic' };
    }
    return name && metadata.nameSource !== 'derived'
        ? {
              title: name,
              ...(metadata.nameSource === 'user'
                  ? { titleSource: 'explicit' as const }
                  : { titleSource: 'automatic' as const }),
          }
        : {};
}

/**
 * Reads Claude Code's compact live-session metadata, plus a bounded incremental scan of the matched session's own
 * transcript for its AI-generated title (the live metadata `name` is only derived from the working directory).
 */
async function readClaudeState(
    context: AgentSnapshotContext,
    configDirectory: string,
): Promise<LocalAgentState | undefined> {
    const entries = await readClaudeSessionMetadata(configDirectory);
    if (!entries) return undefined;
    const requestedRoot = await canonicalPath(context.rootPath);
    const excludedSessionIds = new Set(context.excludedAgentSessionIds);
    /**
     * `realpath` is memoized per probe rather than per cached file so a re-pointed symlink or renamed root is seen on
     * the next probe; distinct working directories are few even when the session directory holds hundreds of files.
     */
    const canonicalCwds = new Map<string, Promise<string>>();
    const canonicalCwd = (cwd: string): Promise<string> => {
        let pending = canonicalCwds.get(cwd);
        if (!pending) {
            pending = canonicalPath(cwd);
            canonicalCwds.set(cwd, pending);
        }
        return pending;
    };
    /**
     * The three in-memory predicates run before any `realpath`, because they are the ones that can reject most of the
     * directory for free. A probe naming its own `agentSessionId` keeps exactly one candidate, so it resolves one path
     * instead of every distinct working directory Claude has ever recorded.
     */
    const candidates = entries.filter(
        (metadata): metadata is ClaudeSessionMetadata & { cwd: string } => {
            if (typeof metadata.cwd !== 'string') return false;
            if (context.agentSessionId) return metadata.sessionId === context.agentSessionId;
            if (
                typeof metadata.sessionId === 'string' &&
                excludedSessionIds.has(metadata.sessionId)
            )
                return false;
            return !(context.startedAt && sessionStartedAt(metadata) < context.startedAt);
        },
    );
    const resolved = await mapWithConcurrency(
        candidates,
        MAX_CONCURRENT_CLAUDE_CWD_READS,
        async (metadata) =>
            (await canonicalCwd(metadata.cwd)) === requestedRoot ? metadata : undefined,
    );
    const matches = resolved.filter((metadata) => metadata !== undefined);
    let latest: ClaudeSessionMetadata | undefined;
    for (const metadata of matches) {
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
        ...(await resolveClaudeTitle(latest, configDirectory)),
    };
}

export const claudeProvider: AgentProviderDescriptor = {
    delegation: claudeDelegationAdapter,
    generateTitle: (context) =>
        generateClaudeLowCostText(
            context,
            AGENT_TITLE_SYSTEM_INSTRUCTIONS,
            'Automatic Session naming',
        ),
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
    probeCacheCounters: claudeMetadataCacheCounters,
    readState: (context, environment) =>
        readClaudeState(context, resolveClaudeConfigDirectory(environment)),
    renameSession: renameClaudeSession,
    resumeArguments: (agentSessionId) => ['--resume', agentSessionId],
    timelineProjector: appendClaudeTimelineRecord,
    transcriptBaseRoot: (environment) =>
        claudeTranscriptBaseRoot(resolveClaudeConfigDirectory(environment)),
    transcriptPath: ({ agentSessionId, cwd }, environment) =>
        claudeTranscriptPath(resolveClaudeConfigDirectory(environment), cwd, agentSessionId),
    transcriptRoot: ({ cwd }, environment) =>
        claudeTranscriptRoot(resolveClaudeConfigDirectory(environment), cwd),
};
