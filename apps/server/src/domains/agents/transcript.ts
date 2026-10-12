import { Buffer } from 'node:buffer';
import { lstat } from 'node:fs/promises';

import type { AgentProvider, AgentTranscript } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import type { AgentEnvironment } from './contract';
import {
    agentProviderStateRoot,
    defaultAgentEnvironment,
    isOpaqueAgentSessionId,
} from './contract';
import { agentProviders } from './providers';
import type { AgentTranscriptLocation } from './transcript-security';
import { openSafeAgentTranscript, resolveSafeAgentTranscriptPath } from './transcript-security';

/**
 * Transport cap for one transcript read. Oversized transcripts keep their tail: the newest turns are what a live
 * inspection needs, and are flagged `truncated`.
 */
export const MAX_AGENT_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

export interface DelegationTranscriptBatch {
    content: string;
    offset?: number;
    isFinished?: boolean;
    failure?: 'payload_overflow' | 'result_missing';
}

/**
 * A task starts at the bounded tail, including a completion already written before its hook arrives. Later polls read
 * only appended complete lines; observing the current file size as the initial cursor would lose fast answers. The
 * native identity is checked independently of the asynchronous caller's launch/revision fence.
 */
export async function readDelegationTranscript(
    database: CaxriDatabase,
    terminalId: string,
    sessionId: string,
    offset: number | undefined,
    environment: AgentEnvironment,
    turnId?: string,
): Promise<DelegationTranscriptBatch> {
    const identity = boundAgentIdentity(database, terminalId);
    if (!identity || identity.agentSessionId !== sessionId) return { content: '' };
    const status = turnId
        ? await agentProviders[identity.provider].readTurnStatus?.(
              { agentSessionId: sessionId, agentTurnId: turnId },
              environment,
          )
        : undefined;
    const location = await locateAgentTranscript(database, terminalId, environment);
    return {
        ...(await readDelegationTranscriptFile(location, offset)),
        ...(turnId && { isFinished: status === 'completed' || status === 'failed' }),
    };
}

async function readDelegationTranscriptFile(
    location: AgentTranscriptLocation | undefined,
    offset: number | undefined,
): Promise<DelegationTranscriptBatch> {
    const opened = location && (await openSafeAgentTranscript(location));
    if (!opened) return { content: '' };
    const { handle, stats } = opened;
    try {
        if (
            offset !== undefined &&
            (!Number.isSafeInteger(offset) || offset < 0 || offset > stats.size)
        )
            return { content: '', failure: 'result_missing' };
        const start = offset ?? Math.max(0, stats.size - MAX_AGENT_TRANSCRIPT_BYTES);
        const length = Math.min(MAX_AGENT_TRANSCRIPT_BYTES, stats.size - start);
        if (length === 0) return { content: '', offset: start };
        const buffer = Buffer.allocUnsafe(length);
        let read = 0;
        while (read < length) {
            // eslint-disable-next-line no-await-in-loop -- the next file offset depends on the previous read
            const result = await handle.read(buffer, read, length - read, start + read);
            if (result.bytesRead === 0) break;
            read += result.bytesRead;
        }
        const bytes = buffer.subarray(0, read);
        const end = bytes.lastIndexOf(0x0a);
        if (end === -1)
            return {
                content: '',
                offset: start,
                failure: read === MAX_AGENT_TRANSCRIPT_BYTES ? 'payload_overflow' : undefined,
            };
        const first = offset === undefined && start > 0 ? bytes.indexOf(0x0a) + 1 : 0;
        return {
            content: bytes.subarray(first, end + 1).toString('utf8'),
            offset: start + end + 1,
        };
    } finally {
        await handle.close();
    }
}

export interface AgentTranscriptIdentity {
    agentSessionId: string;
    cwd: string;
    provider: AgentProvider;
}

export function boundAgentIdentity(
    database: CaxriDatabase,
    terminalId: string,
): AgentTranscriptIdentity | undefined {
    const terminal = database.getTerminal(terminalId);
    if (
        !terminal?.provider ||
        !terminal.agentSessionId ||
        !isOpaqueAgentSessionId(terminal.agentSessionId)
    )
        return;
    return {
        agentSessionId: terminal.agentSessionId,
        /**
         * Claude Code's `EnterWorktree` moves the Agent's directory mid-session and relocates the existing transcript
         * file to the matching provider directory. Resolving against the launch root would keep reading a path the
         * provider has already abandoned, silently stopping every transcript-backed capability.
         */
        cwd: agentProviderStateRoot(terminal),
        provider: terminal.provider,
    };
}

export function resolveAgentTranscriptLocation(
    database: CaxriDatabase,
    terminalId: string,
    environment: AgentEnvironment = defaultAgentEnvironment(),
): AgentTranscriptLocation | undefined {
    const identity = boundAgentIdentity(database, terminalId);
    return identity && deriveAgentTranscriptLocation(identity, environment);
}

function deriveAgentTranscriptLocation(
    identity: AgentTranscriptIdentity,
    environment: AgentEnvironment,
): AgentTranscriptLocation | undefined {
    const provider = agentProviders[identity.provider];
    const path = provider.transcriptPath?.(identity, environment);
    const baseRoot = provider.transcriptBaseRoot?.(environment);
    const root = provider.transcriptRoot?.({ cwd: identity.cwd }, environment);
    return path && root && baseRoot ? { baseRoot, path, root } : undefined;
}

/**
 * Locates the transcript of an Agent Session that may no longer be bound to any Terminal, such as a usage ledger row.
 * The caller supplies the provider state root recorded at binding time.
 */
export async function locateAgentTranscriptForIdentity(
    identity: AgentTranscriptIdentity,
    environment: AgentEnvironment = defaultAgentEnvironment(),
    signal?: AbortSignal,
): Promise<AgentTranscriptLocation | undefined> {
    signal?.throwIfAborted();
    if (!isOpaqueAgentSessionId(identity.agentSessionId)) return;
    return (
        deriveAgentTranscriptLocation(identity, environment) ??
        agentProviders[identity.provider].locateTranscript?.(identity, environment, signal)
    );
}

/**
 * Pure derivation first, then the provider's directory lookup for transcripts whose name cannot be computed (Codex).
 * Callers that only need a synchronous, filesystem-free answer keep using `resolveAgentTranscriptLocation`.
 */
export async function locateAgentTranscript(
    database: CaxriDatabase,
    terminalId: string,
    environment: AgentEnvironment = defaultAgentEnvironment(),
    signal?: AbortSignal,
): Promise<AgentTranscriptLocation | undefined> {
    signal?.throwIfAborted();
    const identity = boundAgentIdentity(database, terminalId);
    if (!identity) return;
    return locateAgentTranscriptForIdentity(identity, environment, signal);
}

async function readTranscriptTail(
    location: AgentTranscriptLocation,
    maxBytes: number,
): Promise<{ content: string; truncated: boolean } | undefined> {
    const opened = await openSafeAgentTranscript(location);
    if (!opened) return;
    const { handle, stats } = opened;
    try {
        const isTruncated = stats.size > maxBytes;
        const readBytes = isTruncated ? maxBytes : stats.size;
        const offset = stats.size - readBytes;
        const buffer = Buffer.allocUnsafe(readBytes);
        let bytesRead = 0;
        while (bytesRead < readBytes) {
            // Each read's offset depends on the byte count already read, so the reads are
            // inherently sequential.
            // eslint-disable-next-line no-await-in-loop -- sequential-by-offset read, see comment above
            const result = await handle.read(
                buffer,
                bytesRead,
                readBytes - bytesRead,
                offset + bytesRead,
            );
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        let content = buffer.subarray(0, bytesRead).toString('utf8');
        // A tail read starts mid-record; drop the partial first line so the viewer only shows
        // complete jsonl records.
        if (isTruncated) {
            const firstNewline = content.indexOf('\n');
            if (firstNewline !== -1) content = content.slice(firstNewline + 1);
        }
        return { content, truncated: isTruncated };
    } catch {
        return undefined;
    } finally {
        await handle.close();
    }
}

/**
 * Resolves and reads the on-disk transcript for a bound Agent Terminal. The path is derived Server-side from the
 * Terminal's durable identity (provider, cwd, Agent session): the caller never supplies a filesystem path, so this
 * deliberate out-of-Project read cannot be steered anywhere the owning provider does not already write.
 */
export async function readAgentTranscript(
    database: CaxriDatabase,
    terminalId: string,
    shouldIncludeContent: boolean,
    environment: AgentEnvironment = defaultAgentEnvironment(),
    /**
     * How much of the transcript's tail to read; Agent Chat reads far more when paging back through a long history.
     */
    maxBytes = MAX_AGENT_TRANSCRIPT_BYTES,
): Promise<AgentTranscript | null> {
    const location = await locateAgentTranscript(database, terminalId, environment);
    if (!location) return null;
    const safe = await resolveSafeAgentTranscriptPath(location);
    if (!safe) {
        try {
            await lstat(location.path);
            return null;
        } catch {
            return { path: location.path, exists: false, truncated: false };
        }
    }
    if (!shouldIncludeContent) {
        return { path: location.path, exists: safe.exists, truncated: false };
    }
    if (!safe.exists) return { path: location.path, exists: false, truncated: false };
    const tail = await readTranscriptTail(location, maxBytes);
    if (!tail) return { path: location.path, exists: false, truncated: false };
    return { path: location.path, exists: true, content: tail.content, truncated: tail.truncated };
}

/**
 * Whether the Terminal's bound conversation provably never reached disk, so `--resume` would only print "No
 * conversation found" and exit. Claude Code assigns its session id at launch but writes the transcript with the first
 * prompt; an Agent parked before any input (the `untouched` suspension sweep) therefore has an id with nothing behind
 * it, and the restore must start a fresh Agent instead. Only a pure `transcriptPath` can prove absence: a
 * `locateTranscript` miss may be a fail-closed scan budget rather than a missing file, so those providers keep
 * resuming. Any error other than `ENOENT` also keeps the resume.
 */
export async function isAgentConversationUnwritten(
    database: CaxriDatabase,
    terminalId: string,
    environment: AgentEnvironment = defaultAgentEnvironment(),
): Promise<boolean> {
    const location = resolveAgentTranscriptLocation(database, terminalId, environment);
    if (!location) return false;
    try {
        await lstat(location.path);
        return false;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
}
