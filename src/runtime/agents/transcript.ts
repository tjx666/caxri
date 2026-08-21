import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, stat } from 'node:fs/promises';

import type { AgentTranscript } from '../../shared/types';
import type { CaxriDatabase } from '../db';
import type { AgentEnvironment } from './contract';
import { defaultAgentEnvironment } from './contract';
import { agentProviders } from './providers';

/**
 * Transport cap for one transcript read. Oversized transcripts keep their tail — the newest turns are what a live
 * inspection needs — and are flagged `truncated`.
 */
export const MAX_AGENT_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

export function resolveAgentTranscriptPath(
    database: CaxriDatabase,
    terminalId: string,
    environment: AgentEnvironment = defaultAgentEnvironment(),
): string | undefined {
    const terminal = database.getTerminal(terminalId);
    if (!terminal?.provider || !terminal.agentSessionId) return;
    return agentProviders[terminal.provider].transcriptPath?.(
        { agentSessionId: terminal.agentSessionId, cwd: terminal.cwd },
        environment,
    );
}

async function readTranscriptTail(
    path: string,
): Promise<{ content: string; truncated: boolean } | undefined> {
    let handle: FileHandle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch {
        return undefined;
    }
    try {
        const stats = await handle.stat();
        if (!stats.isFile()) return undefined;
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
    const path = resolveAgentTranscriptPath(database, terminalId, environment);
    if (path === undefined) return null;
    if (!shouldIncludeContent) {
        try {
            const stats = await stat(path);
            return { path, exists: stats.isFile(), truncated: false };
        } catch {
            return { path, exists: false, truncated: false };
        }
    }
    const tail = await readTranscriptTail(path);
    if (!tail) return { path, exists: false, truncated: false };
    return { path, exists: true, content: tail.content, truncated: tail.truncated };
}
