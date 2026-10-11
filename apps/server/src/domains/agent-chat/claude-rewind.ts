import { appendFile, mkdir, readFile } from 'node:fs/promises';
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
    ChatForkTarget,
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

function configDirectory(environment: NodeJS.ProcessEnv): string {
    // `||` is deliberate: Claude Code ignores an empty override too.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string is invalid here
    return environment.CLAUDE_CONFIG_DIR || join(environment.HOME ?? homedir(), '.claude');
}

const STORE_KEY_PART = /^[\w.-]{1,255}$/u;

/**
 * Claude Code's own transcript files under `configDirectory`, as an Agent SDK session store. The SDK's session
 * functions otherwise find the folder through Server Core's environment, resolved once per process, while each Chat's
 * Claude Code runs with its own environment.
 */
function claudeTranscriptStore(configDirectory: string): SessionStore {
    const file = (key: SessionKey): string => {
        const parts = [key.projectKey, key.sessionId, ...(key.subpath ? [key.subpath] : [])];
        if (parts.some((part) => !STORE_KEY_PART.test(part) || /^\.+$/u.test(part)))
            throw new CaxriError('VALIDATION', 'Claude named an unexpected transcript');
        const name = key.subpath ? join(key.sessionId, key.subpath) : key.sessionId;
        return join(configDirectory, 'projects', key.projectKey, `${name}.jsonl`);
    };
    return {
        async load(key) {
            let text: string;
            try {
                text = await readFile(file(key), 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            }
            return text
                .split('\n')
                .filter((line) => line.trim())
                .map((line) => JSON.parse(line) as SessionStoreEntry);
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
 * only the conversation it adds. `undefined` when the message opened the conversation.
 */
export async function forkClaudeSession(
    sessionId: string,
    host: Pick<AgentChatSessionHost, 'cwd' | 'environment'>,
    transcript: AgentChatTranscript | undefined,
    target: ChatForkTarget,
): Promise<string | undefined> {
    const point = transcript && claudeRewindPoint(transcript.content, target.itemId);
    if (point?.kind === 'fresh') return undefined;
    if (!point)
        throw new CaxriError(
            'CONFLICT',
            "This message is older than the part of Claude's record Caxri reads",
        );
    const { forkSession } = await import('@anthropic-ai/claude-agent-sdk');
    try {
        const forked = await forkSession(sessionId, {
            dir: host.cwd,
            upToMessageId: point.at,
            sessionStore: claudeTranscriptStore(configDirectory(host.environment)),
        });
        return forked.sessionId;
    } catch (error) {
        throw new CaxriError(
            'UNAVAILABLE',
            clip(
                `Claude could not fork this conversation: ${error instanceof Error ? error.message : 'unknown error'}`,
                300,
            ),
        );
    }
}
