import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers/promises';

import { compactInlineMediaPayloads } from '../inline-media';
import type { AgentTranscriptLocation } from '../transcript-security';
import { openSafeAgentTranscript } from '../transcript-security';
import { extractVisibleTranscriptMessage } from '../visible-transcript-message';

const MAX_TEXT_CHARS = 128 * 1024;
const MAX_RECORD_CHARS = 256 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

export interface SearchableTranscript {
    text: string;
    partial: boolean;
    bytesRead: number;
}

/**
 * Bounded process-memory cache; even hits reopen and reauthorize the provider-owned transcript.
 */
export class TranscriptSearchReader {
    private readonly cache = new Map<
        string,
        { fingerprint: string; value: SearchableTranscript }
    >();
    private cacheBytes = 0;

    private remember(path: string, fingerprint: string, value: SearchableTranscript): void {
        const previous = this.cache.get(path);
        if (previous) this.cacheBytes -= previous.value.text.length * 2;
        this.cache.delete(path);
        this.cache.set(path, { fingerprint, value });
        this.cacheBytes += value.text.length * 2;
        while (this.cacheBytes > MAX_CACHE_BYTES || this.cache.size > 64) {
            const oldest = this.cache.keys().next().value!;
            this.cacheBytes -= this.cache.get(oldest)!.value.text.length * 2;
            this.cache.delete(oldest);
        }
    }

    async read(
        location: AgentTranscriptLocation,
        maxBytes: number,
        signal: AbortSignal,
    ): Promise<SearchableTranscript | undefined> {
        signal.throwIfAborted();
        const opened = await openSafeAgentTranscript(location);
        if (!opened) return undefined;
        const { handle, stats, path } = opened;
        try {
            signal.throwIfAborted();
            const fingerprint = [
                stats.dev,
                stats.ino,
                stats.size,
                stats.mtimeMs,
                stats.ctimeMs,
            ].join(':');
            const cached = this.cache.get(path);
            if (
                cached?.fingerprint === fingerprint &&
                (!cached.value.partial || cached.value.bytesRead >= maxBytes)
            )
                return { ...cached.value, bytesRead: 0 };
            const buffer = Buffer.alloc(Math.min(stats.size, maxBytes));
            let offset = 0;
            /* eslint-disable no-await-in-loop -- bounded sequential file offsets and cooperative parse yields */
            while (offset < buffer.length) {
                signal.throwIfAborted();
                const { bytesRead } = await handle.read(
                    buffer,
                    offset,
                    Math.min(64 * 1024, buffer.length - offset),
                    offset,
                );
                if (bytesRead === 0) break;
                offset += bytesRead;
            }
            let isPartial = offset < stats.size;
            const source = buffer.subarray(0, offset).toString('utf8');
            const lines = source.split('\n');
            if (isPartial) lines.pop();
            const pieces: string[] = [];
            let retained = 0;
            let chunkRole: string | undefined;
            for (const [index, line] of lines.entries()) {
                signal.throwIfAborted();
                if (index % 64 === 0) await setImmediate();
                if (!line.trim()) continue;
                // A pasted screenshot is what pushes a prompt record past the ceiling, so it is collapsed before the check.
                const recordLine =
                    line.length > MAX_RECORD_CHARS ? compactInlineMediaPayloads(line) : line;
                if (recordLine.length > MAX_RECORD_CHARS) {
                    isPartial = true;
                    chunkRole = undefined;
                    continue;
                }
                let record: unknown;
                try {
                    record = JSON.parse(recordLine);
                } catch {
                    isPartial = true;
                    chunkRole = undefined;
                    continue;
                }
                const message = extractVisibleTranscriptMessage(record);
                if (!message) {
                    chunkRole = undefined;
                    continue;
                }
                const separator = message.isChunk && chunkRole === message.role ? '' : '\n';
                const remaining = MAX_TEXT_CHARS - retained;
                const text = separator + message.text;
                pieces.push(text.slice(0, remaining));
                retained += Math.min(text.length, remaining);
                chunkRole = message.isChunk ? message.role : undefined;
                if (text.length > remaining) {
                    isPartial = true;
                    break;
                }
            }
            const current = await handle.stat();
            const isStable =
                current.size === stats.size &&
                current.mtimeMs === stats.mtimeMs &&
                current.ctimeMs === stats.ctimeMs;
            const value = {
                text: pieces.join(''),
                partial: isPartial || !isStable || (retained === 0 && source.trim().length > 0),
                bytesRead: offset,
            };
            if (isStable && !signal.aborted) this.remember(path, fingerprint, value);
            return value;
            /* eslint-enable no-await-in-loop */
        } finally {
            await handle.close();
        }
    }
}
