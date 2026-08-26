import { Buffer } from 'node:buffer';
import { lstat } from 'node:fs/promises';

import type { AgentTranscript } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import type { AgentEnvironment } from './contract';
import { defaultAgentEnvironment, isOpaqueAgentSessionId } from './contract';
import { agentProviders } from './providers';
import type { AgentTranscriptLocation } from './transcript-security';
import { openSafeAgentTranscript, resolveSafeAgentTranscriptPath } from './transcript-security';

/**
 * Transport cap for one transcript read. Oversized transcripts keep their tail — the newest turns are what a live
 * inspection needs — and are flagged `truncated`.
 */
export const MAX_AGENT_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

export function resolveAgentTranscriptLocation(
    database: CaxriDatabase,
    terminalId: string,
    environment: AgentEnvironment = defaultAgentEnvironment(),
): AgentTranscriptLocation | undefined {
    const terminal = database.getTerminal(terminalId);
    if (
        !terminal?.provider ||
        !terminal.agentSessionId ||
        !isOpaqueAgentSessionId(terminal.agentSessionId)
    )
        return;
    const provider = agentProviders[terminal.provider];
    const path = provider.transcriptPath?.(
        { agentSessionId: terminal.agentSessionId, cwd: terminal.cwd },
        environment,
    );
    const baseRoot = provider.transcriptBaseRoot?.(environment);
    const root = provider.transcriptRoot?.({ cwd: terminal.cwd }, environment);
    return path && root && baseRoot ? { baseRoot, path, root } : undefined;
}

async function readTranscriptTail(
    location: AgentTranscriptLocation,
): Promise<{ content: string; truncated: boolean } | undefined> {
    const opened = await openSafeAgentTranscript(location);
    if (!opened) return;
    const { handle, stats } = opened;
    try {
        const isTruncated = stats.size > MAX_AGENT_TRANSCRIPT_BYTES;
        const readBytes = isTruncated ? MAX_AGENT_TRANSCRIPT_BYTES : stats.size;
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
 * Resolves and reads the on-disk transcript for a bound Agent Terminal. The path is derived Runtime-side from the
 * Terminal's durable identity (provider, cwd, Agent session) — the caller never supplies a filesystem path, so this
 * deliberate out-of-Project read cannot be steered anywhere the owning provider does not already write.
 */
export async function readAgentTranscript(
    database: CaxriDatabase,
    terminalId: string,
    shouldIncludeContent: boolean,
    environment: AgentEnvironment = defaultAgentEnvironment(),
): Promise<AgentTranscript | null> {
    const location = resolveAgentTranscriptLocation(database, terminalId, environment);
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
    const tail = await readTranscriptTail(location);
    if (!tail) return { path: location.path, exists: false, truncated: false };
    return { path: location.path, exists: true, content: tail.content, truncated: tail.truncated };
}
