import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
    Query,
    SessionKey,
    SessionStore,
    SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';
import { CaxriError } from '@caxri/protocol';

import { clip } from './chat-items';
import type {
    AgentChatSessionHost,
    AgentChatTranscript,
    ChatFork,
    ChatForkTarget,
    ChatRestorePreview,
    ChatResumePoint,
    ChatRewindTarget,
} from './chat-provider';
import { claudeRewindPoint } from './claude-history';

/**
 * Claude Code rewinds a conversation only by resuming it at an earlier record (`resumeSessionAt`), so this finds that
 * point in the transcript and leaves the resume to the restart that follows. Files go back first through
 * {@link restoreClaudeFiles}.
 */
export async function rewindClaudeSession(
    query: Query,
    transcript: AgentChatTranscript | undefined,
    target: ChatRewindTarget,
): Promise<ChatResumePoint> {
    const point = transcript && claudeRewindPoint(transcript.content, target.itemId);
    if (!point)
        throw new CaxriError(
            'CONFLICT',
            "This message is older than the part of Claude's record Caxri reads",
        );
    if (target.restoreFiles) await restoreClaudeFiles(query, target.itemId);
    return point;
}

/**
 * Restores the files Claude Code changed since user message `itemId` from the SDK's file checkpoints, leaving the
 * conversation as it is. A dry run first proves a checkpoint exists for the message (a turn that ran before
 * checkpointing was enabled has none) before anything on disk changes.
 */
export async function restoreClaudeFiles(
    query: Pick<Query, 'rewindFiles'>,
    itemId: string,
): Promise<void> {
    const preview = await query.rewindFiles(itemId, { dryRun: true });
    if (!preview.canRewind)
        throw new CaxriError(
            'CONFLICT',
            clip(
                `Claude cannot restore files for this message: ${preview.error ?? 'no checkpoint'}`,
                300,
            ),
        );
    const applied = await query.rewindFiles(itemId);
    if (!applied.canRewind)
        throw new CaxriError(
            'UNAVAILABLE',
            clip(`Claude could not restore files: ${applied.error ?? 'unknown error'}`, 300),
        );
}

/**
 * What {@link restoreClaudeFiles} would put back, from the SDK's dry run: nothing on disk changes. A checkpoint the dry
 * run cannot find fails with `CONFLICT`, as the restore itself would.
 */
export async function previewClaudeRestore(
    query: Pick<Query, 'rewindFiles'>,
    itemId: string,
): Promise<ChatRestorePreview> {
    const preview = await query.rewindFiles(itemId, { dryRun: true });
    if (!preview.canRewind)
        throw new CaxriError(
            'CONFLICT',
            clip(
                `Claude cannot restore files for this message: ${preview.error ?? 'no checkpoint'}`,
                300,
            ),
        );
    return {
        files: preview.filesChanged ?? [],
        ...(preview.insertions !== undefined && { insertions: preview.insertions }),
        ...(preview.deletions !== undefined && { deletions: preview.deletions }),
    };
}

function configDirectory(environment: NodeJS.ProcessEnv): string {
    // `||` is deliberate: Claude Code ignores an empty override too.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string is invalid here
    return environment.CLAUDE_CONFIG_DIR || join(environment.HOME ?? homedir(), '.claude');
}

const STORE_KEY_PART = /^[\w.-]{1,255}$/u;

/**
 * The largest transcript a fork loads. The SDK's session store contract hands it the whole session (no tail read), so
 * this only stops a runaway file from being read into memory; real transcripts are far smaller.
 */
const MAX_CLAUDE_FORK_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

/**
 * Claude Code's own transcript files under `configDirectory`, as an Agent SDK session store. The SDK's session
 * functions otherwise find the folder through Server Core's environment, resolved once per process, while each Chat's
 * Claude Code runs with its own environment.
 *
 * `load` skips a line that is not valid JSON (a truncated trailing line from an interrupted write, a corrupt record)
 * the way the SDK's own loader does, and counts it in `skippedRecords` so the fork can log it. A file above `maxBytes`
 * fails with `CAPACITY` before it is read.
 */
function claudeTranscriptStore(
    configDirectory: string,
    maxBytes = MAX_CLAUDE_FORK_TRANSCRIPT_BYTES,
): SessionStore & { readonly skippedRecords: number } {
    const file = (key: SessionKey): string => {
        const parts = [key.projectKey, key.sessionId, ...(key.subpath ? [key.subpath] : [])];
        if (parts.some((part) => !STORE_KEY_PART.test(part) || /^\.+$/u.test(part)))
            throw new CaxriError('VALIDATION', 'Claude named an unexpected transcript');
        const name = key.subpath ? join(key.sessionId, key.subpath) : key.sessionId;
        return join(configDirectory, 'projects', key.projectKey, `${name}.jsonl`);
    };
    let skippedRecords = 0;
    return {
        get skippedRecords() {
            return skippedRecords;
        },
        async load(key) {
            const path = file(key);
            let text: string;
            try {
                const { size } = await stat(path);
                if (size > maxBytes)
                    throw new CaxriError(
                        'CAPACITY',
                        `This Claude conversation is too large to fork (${Math.ceil(size / 1024 / 1024)} MiB; the limit is ${Math.floor(maxBytes / 1024 / 1024)} MiB)`,
                    );
                text = await readFile(path, 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            }
            const entries: SessionStoreEntry[] = [];
            for (const line of text.split('\n')) {
                if (!line.trim()) continue;
                try {
                    entries.push(JSON.parse(line) as SessionStoreEntry);
                } catch {
                    skippedRecords += 1;
                }
            }
            return entries;
        },
        async append(key, entries) {
            const path = file(key);
            await mkdir(dirname(path), { recursive: true });
            await appendFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
        },
    };
}

/**
 * The Agent SDK's `forkSession` copies the transcript, with new message ids, up to and including the record a rewind
 * would resume at, into a new session the new Chat resumes. File checkpoints are not copied, so the fork can rewind
 * only the conversation it adds. No `agentSessionId` when the message opened the conversation; `skippedRecords` counts
 * the transcript lines that were not valid JSON and were left out.
 */
export async function forkClaudeSession(
    sessionId: string,
    host: Pick<AgentChatSessionHost, 'cwd' | 'environment'>,
    transcript: AgentChatTranscript | undefined,
    target: ChatForkTarget,
    maxBytes?: number,
): Promise<ChatFork> {
    const point = transcript && claudeRewindPoint(transcript.content, target.itemId);
    if (point?.kind === 'fresh') return { agentSessionId: undefined };
    if (!point)
        throw new CaxriError(
            'CONFLICT',
            "This message is older than the part of Claude's record Caxri reads",
        );
    const { forkSession } = await import('@anthropic-ai/claude-agent-sdk');
    const sessionStore = claudeTranscriptStore(configDirectory(host.environment), maxBytes);
    try {
        const forked = await forkSession(sessionId, {
            dir: host.cwd,
            upToMessageId: point.at,
            sessionStore,
        });
        return { agentSessionId: forked.sessionId, skippedRecords: sessionStore.skippedRecords };
    } catch (error) {
        // The store's own refusal (an oversized transcript) already says what happened.
        if (error instanceof CaxriError) throw error;
        throw new CaxriError(
            'UNAVAILABLE',
            clip(
                `Claude could not fork this conversation: ${error instanceof Error ? error.message : 'unknown error'}`,
                300,
            ),
        );
    }
}
