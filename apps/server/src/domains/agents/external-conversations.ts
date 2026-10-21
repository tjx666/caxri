import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { mapWithConcurrency } from '@caxri/system';

import type { AgentEnvironment } from './contract';
import { isOpaqueAgentSessionId } from './contract';
import type {
    CodexThreadIndex,
    ConversationCandidate as Candidate,
    ExternalConversationProvider,
    ParsedConversation,
} from './external-conversation-parsers';
import {
    parseConversationCandidate,
    readCodexThreadIndex,
    settled,
} from './external-conversation-parsers';
import { claudeTranscriptBaseRoot, resolveClaudeConfigDirectory } from './providers/claude/paths';
import { resolveCodexHome } from './providers/codex/paths';
import { parseCodexRolloutName } from './providers/codex/rollouts';
import { grokHome } from './providers/grok/paths';

/**
 * One Agent conversation found in a provider's own store on this machine, typically started outside Caxri.
 */
export interface ExternalConversation {
    provider: ExternalConversationProvider;
    /**
     * The provider's own conversation id, exactly what that provider's resume argument takes.
     */
    providerSessionId: string;
    /**
     * Absolute working directory the conversation ran in, read from the transcript itself, never decoded from a lossy
     * directory name.
     */
    cwd: string;
    /**
     * A short display title: the provider's own title if it records one, else the first real user prompt, collapsed to
     * one line and capped at 120 characters. Undefined when neither exists.
     */
    title?: string;
    /**
     * Transcript mtime in milliseconds.
     */
    updatedAt: number;
    /**
     * True when evidence says another process may still have the conversation open: the Codex open-file probe when one
     * is supplied, otherwise a transcript written within {@link RECENTLY_WRITTEN_MS} of `now`.
     */
    mayBeOpen: boolean;
}

export interface ListExternalConversationsOptions {
    environment: AgentEnvironment;
    now: number;
    /**
     * Conversations already bound to a Caxri Terminal (`TerminalRecord.agentSessionId`); excluded from the result.
     */
    excludeProviderSessionIds: ReadonlySet<string>;
    /**
     * Only conversations updated within this window. Default 30 days.
     */
    maxAgeMs?: number;
    /**
     * Result cap, newest first. Default 200.
     */
    limit?: number;
    /**
     * Thread ids some live Codex process holds a writable rollout handle for (see `codexSessionIdsFromOpenFiles` in
     * `providers/codex/index.ts`), normally `probeOpenCodexSessionIds` in `providers/codex/open-sessions.ts`. Omitted,
     * resolving `undefined` (the probe could not answer), or rejecting falls back to the transcript recency heuristic.
     */
    openCodexSessionIds?: () => Promise<ReadonlySet<string> | undefined>;
}

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 200;
/**
 * Claude Code and Grok Build expose no open-file evidence this module can use, so a transcript written this recently is
 * treated as possibly still attached to a running CLI.
 */
const RECENTLY_WRITTEN_MS = 2 * 60 * 1000;
/**
 * Directory entries examined per provider. Bounds listing cost on a machine with thousands of rollouts.
 */
const MAX_LISTED_ENTRIES_PER_PROVIDER = 8192;
/**
 * Transcripts whose content is opened per call. Skipped candidates (subagents, headless runs, empty conversations)
 * consume this budget too, so a store full of skippable files cannot make one call unbounded.
 */
const MAX_CONTENT_READS = 1000;
const IO_CONCURRENCY = 8;

/**
 * Lists Agent conversations recorded by Claude Code, Codex, and Grok Build on this machine, newest first.
 *
 * Cost is bounded: candidates are found with directory listings and `stat` only, then filtered by age, exclusion, and
 * sorted before any content is read; only a bounded head (and for Claude a bounded tail) of each examined transcript is
 * read. Unreadable or malformed files are skipped silently.
 *
 * Skipped as not resumable or not the user's own: Claude sidechain transcripts (top-level `isSidechain` records and the
 * `<id>/subagents/` subtree, which listing never descends into) and conversations started through the SDK or print mode
 * (first `entrypoint` `sdk-*`); Codex subagent threads and `codex exec` runs; Grok headless and subagent conversations;
 * any conversation opened by Caxri's delegated-task pointer; and conversations with neither a provider title nor a
 * visible user prompt. Injected prompts (AGENTS.md and environment blocks, `<command-name>` echoes, caveats, system
 * reminders) never count as the user's prompt; this reuses the shared visible-message boundary in
 * `title-generation.ts`.
 *
 * The result reaches a local UI only. Nothing here logs titles, prompts, paths, or transcript content.
 */
export async function listExternalConversations(
    options: ListExternalConversationsOptions,
): Promise<ExternalConversation[]> {
    const { environment, excludeProviderSessionIds, now } = options;
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (limit <= 0) return [];
    const oldest = now - maxAgeMs;

    const listed = await Promise.all([
        listClaudeCandidates(environment),
        listCodexCandidates(environment),
        listGrokCandidates(environment),
    ]);
    const recent = listed
        .flat()
        .filter(
            (candidate) =>
                candidate.updatedAt >= oldest &&
                !excludeProviderSessionIds.has(candidate.providerSessionId),
        );
    const codexIds = recent.flatMap((candidate) =>
        candidate.provider === 'codex' ? [candidate.providerSessionId] : [],
    );
    const codexIndex: CodexThreadIndex =
        codexIds.length > 0
            ? await readCodexThreadIndex(environment, codexIds)
            : { names: new Map(), skipped: new Set() };
    // Known subagent and `exec` threads are dropped before the read budget so they cannot crowd out real conversations.
    const candidates = recent
        .filter(
            (candidate) =>
                candidate.provider !== 'codex' ||
                !codexIndex.skipped.has(candidate.providerSessionId),
        )
        .toSorted((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_CONTENT_READS);
    if (candidates.length === 0) return [];

    const openCodexIds =
        options.openCodexSessionIds &&
        candidates.some((candidate) => candidate.provider === 'codex')
            ? await settled(options.openCodexSessionIds)
            : undefined;
    const toConversation = (
        candidate: Candidate,
        parsed: ParsedConversation,
    ): ExternalConversation => ({
        provider: candidate.provider,
        providerSessionId: candidate.providerSessionId,
        cwd: parsed.cwd,
        ...(parsed.title && { title: parsed.title }),
        updatedAt: candidate.updatedAt,
        mayBeOpen:
            openCodexIds && candidate.provider === 'codex'
                ? openCodexIds.has(candidate.providerSessionId)
                : now - candidate.updatedAt <= RECENTLY_WRITTEN_MS,
    });

    const results: ExternalConversation[] = [];
    const batchSize = IO_CONCURRENCY * 2;
    for (let index = 0; index < candidates.length && results.length < limit; index += batchSize) {
        const batch = candidates.slice(index, index + batchSize);
        // Batches run in recency order so reading stops as soon as `limit` conversations are accepted.
        // eslint-disable-next-line no-await-in-loop -- ordered early-exit batches, see comment above
        const parsed = await mapWithConcurrency(batch, IO_CONCURRENCY, (candidate) =>
            settled(() => parseConversationCandidate(candidate, codexIndex.names)),
        );
        const accepted = batch.flatMap((candidate, position) => {
            const conversation = parsed[position];
            return conversation && !conversation.isHosted
                ? [toConversation(candidate, conversation)]
                : [];
        });
        results.push(...accepted.slice(0, limit - results.length));
    }
    return results;
}
// Listing

async function listDirectory(path: string) {
    try {
        return await readdir(path, { withFileTypes: true });
    } catch {
        return [];
    }
}

/**
 * Shared per-provider listing budget, so one huge store cannot dominate a call.
 */
class ListingBudget {
    private remaining = MAX_LISTED_ENTRIES_PER_PROVIDER;

    take<T>(entries: T[]): T[] {
        const taken = entries.slice(0, Math.max(0, this.remaining));
        this.remaining -= taken.length;
        return taken;
    }

    get isExhausted(): boolean {
        return this.remaining <= 0;
    }
}

/**
 * Lists one directory level for every parent, in the given priority order, keeping the children `select` maps to a
 * path. Listing stops when the shared budget runs out.
 */
async function listLevel(
    parents: readonly string[],
    budget: ListingBudget,
    select: (entry: Dirent, parent: string) => string | undefined,
): Promise<string[]> {
    const children: string[] = [];
    for (const parent of parents) {
        if (budget.isExhausted) break;
        // eslint-disable-next-line no-await-in-loop -- parents are listed in priority order under one shared budget
        const entries = budget.take(await listDirectory(parent));
        children.push(
            ...entries.flatMap((entry) => {
                const child = select(entry, parent);
                return child === undefined ? [] : [child];
            }),
        );
    }
    return children;
}

async function statCandidates(
    entries: ReadonlyArray<Omit<Candidate, 'updatedAt'>>,
): Promise<Candidate[]> {
    const stats = await mapWithConcurrency(entries, IO_CONCURRENCY, async (entry) => {
        try {
            const metadata = await stat(entry.path);
            return metadata.isFile() ? { ...entry, updatedAt: metadata.mtimeMs } : undefined;
        } catch {
            return;
        }
    });
    return stats.filter((candidate): candidate is Candidate => candidate !== undefined);
}

const childDirectory = (entry: Dirent, parent: string) =>
    entry.isDirectory() ? join(parent, entry.name) : undefined;

/**
 * Claude Code stores `projects/<encoded cwd>/<session id>.jsonl`. Subagent transcripts live one level deeper under
 * `<session id>/subagents/`, so a two-level listing never reaches them. Legacy top-level `agent-*.jsonl` files are
 * sidechains, not resumable conversations.
 */
async function listClaudeCandidates(environment: AgentEnvironment): Promise<Candidate[]> {
    const base = claudeTranscriptBaseRoot(resolveClaudeConfigDirectory(environment));
    const budget = new ListingBudget();
    const projects = await listLevel([base], budget, childDirectory);
    const files = await listLevel(projects, budget, (entry, parent) => {
        const sessionId = entry.name.endsWith('.jsonl') ? entry.name.slice(0, -6) : '';
        return entry.isFile() &&
            isOpaqueAgentSessionId(sessionId) &&
            !sessionId.startsWith('agent-')
            ? join(parent, entry.name)
            : undefined;
    });
    return statCandidates(
        files.map((path) => ({
            provider: 'claude',
            providerSessionId: basename(path, '.jsonl'),
            path,
        })),
    );
}

/**
 * Codex date folders are fixed-width numbers, so a descending path sort is newest first.
 */
function numericDirectory(digits: number) {
    const pattern = new RegExp(String.raw`^\d{${digits}}$`, 'u');
    return (entry: Dirent, parent: string) =>
        entry.isDirectory() && pattern.test(entry.name) ? join(parent, entry.name) : undefined;
}

const newestFirst = (paths: string[]) => paths.toSorted((left, right) => right.localeCompare(left));

/**
 * Codex stores `sessions/YYYY/MM/DD/rollout-<time>-<thread id>[_<rollout id>].jsonl`, in the folder of the day the
 * rollout was created. A thread's mtime can be much newer than its folder, so day folders are not pruned by the age
 * window; they are walked newest first under the listing budget instead. A reverted thread has several rollouts; only
 * its newest is kept.
 */
async function listCodexCandidates(environment: AgentEnvironment): Promise<Candidate[]> {
    const root = join(resolveCodexHome(environment), 'sessions');
    const budget = new ListingBudget();
    const years = newestFirst(await listLevel([root], budget, numericDirectory(4)));
    const months = newestFirst(await listLevel(years, budget, numericDirectory(2)));
    const days = newestFirst(await listLevel(months, budget, numericDirectory(2)));
    const files = await listLevel(days, budget, (entry, parent) => {
        const threadId = entry.isFile() ? parseCodexRolloutName(entry.name)?.threadId : undefined;
        return threadId && isOpaqueAgentSessionId(threadId) ? join(parent, entry.name) : undefined;
    });
    const rollouts = files.flatMap((path) => {
        const threadId = parseCodexRolloutName(basename(path))?.threadId;
        return threadId ? [{ provider: 'codex' as const, providerSessionId: threadId, path }] : [];
    });
    const newestByThread = new Map<string, Candidate>();
    const stated = await statCandidates(rollouts);
    for (const candidate of stated) {
        const current = newestByThread.get(candidate.providerSessionId);
        if (!current || candidate.updatedAt > current.updatedAt)
            newestByThread.set(candidate.providerSessionId, candidate);
    }
    return newestByThread.values().toArray();
}

/**
 * Grok Build stores `sessions/<encoded cwd>/<session id>/updates.jsonl` beside a compact `summary.json`.
 */
async function listGrokCandidates(environment: AgentEnvironment): Promise<Candidate[]> {
    const base = join(grokHome(environment), 'sessions');
    const budget = new ListingBudget();
    const projects = await listLevel([base], budget, childDirectory);
    const sessions = await listLevel(projects, budget, (entry, parent) =>
        entry.isDirectory() && isOpaqueAgentSessionId(entry.name)
            ? join(parent, entry.name)
            : undefined,
    );
    return statCandidates(
        sessions.map((session) => ({
            provider: 'grok',
            providerSessionId: basename(session),
            path: join(session, 'updates.jsonl'),
        })),
    );
}
