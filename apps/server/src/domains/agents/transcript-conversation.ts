import { lstat } from 'node:fs/promises';

import { compactInlineMediaPayloads } from './inline-media';
import type { TranscriptScanOptions } from './transcript-scan';
import { scanTranscriptToEnd } from './transcript-scan';
import type { AgentTranscriptLocation } from './transcript-security';
import type { VisibleTranscriptMessage } from './visible-transcript-message';
import { extractVisibleTranscriptMessage } from './visible-transcript-message';

/**
 * One turn of a condensed conversation: consecutive records of the same role joined into one message.
 */
export interface TranscriptConversationMessage {
    role: 'assistant' | 'user';
    text: string;
}

export interface TranscriptConversation {
    messages: TranscriptConversationMessage[];
    /**
     * Messages dropped from the front because the retained text exceeded the reader's budget; the most recent turns are
     * the ones a referencing Agent most likely needs.
     */
    omittedMessageCount: number;
    /**
     * The transcript was longer than the read window, so only its tail was read and the earlier conversation is absent
     * from `messages` without being counted in `omittedMessageCount`.
     */
    isTailOnly: boolean;
}

/**
 * Pasted screenshots are collapsed before parsing so they cannot dominate the parse cost, the same ceiling Session
 * content search uses.
 */
const MAX_RECORD_CHARS = 256 * 1024;
/**
 * One message longer than this keeps its head. A pasted log or a long generated file is rarely what the referencing
 * Agent needs verbatim, and one such message would otherwise evict every other turn.
 */
const MAX_MESSAGE_CHARS = 16 * 1024;
const TRUNCATED_MESSAGE_SUFFIX = '\n\n[Message truncated]';
/**
 * The scanner stops after a 64 MiB total budget, which on a longer transcript would keep its oldest part and silently
 * miss the newest turns. Starting this far before the end keeps the read inside that budget, with headroom for bytes
 * appended while it runs, and reads the turns a referencing Agent most likely needs.
 */
const MAX_TAIL_WINDOW_BYTES = 48 * 1024 * 1024;

/**
 * Accumulates visible messages under a retained-text budget, dropping the oldest turns once it is exceeded.
 */
class ConversationAccumulator {
    private chunkRole: TranscriptConversationMessage['role'] | undefined;
    private retainedChars = 0;
    readonly messages: TranscriptConversationMessage[] = [];
    omittedMessageCount = 0;

    constructor(private readonly maxRetainedChars: number) {}

    private replaceLast(last: TranscriptConversationMessage, text: string): void {
        const next = bounded(text);
        this.retainedChars += next.length - last.text.length;
        last.text = next;
    }

    private evict(): void {
        while (this.retainedChars > this.maxRetainedChars && this.messages.length > 1) {
            const dropped = this.messages.shift()!;
            this.retainedChars -= dropped.text.length;
            this.omittedMessageCount += 1;
        }
    }

    add(message: VisibleTranscriptMessage): void {
        const last = this.messages.at(-1);
        if (last?.role === message.role) {
            // A Grok stream chunk continues the previous chunk verbatim; any other record of the same role is a new
            // paragraph of the same turn. An identical repeat is a record the scanner re-delivered, not a new turn.
            const isContinuation = message.isChunk && this.chunkRole === message.role;
            if (!isContinuation && last.text.endsWith(message.text)) return;
            this.replaceLast(last, `${last.text}${isContinuation ? '' : '\n\n'}${message.text}`);
        } else {
            const text = bounded(message.text);
            this.messages.push({ role: message.role, text });
            this.retainedChars += text.length;
        }
        this.chunkRole = message.isChunk ? message.role : undefined;
        this.evict();
    }

    /**
     * A record that carries no visible text (a tool call, a tool result) still ends a Grok chunk run.
     */
    interrupt(): void {
        this.chunkRole = undefined;
    }
}

function bounded(text: string): string {
    return text.length > MAX_MESSAGE_CHARS
        ? `${text.slice(0, MAX_MESSAGE_CHARS)}${TRUNCATED_MESSAGE_SUFFIX}`
        : text;
}

interface TranscriptConversationOptions extends TranscriptScanOptions {
    /**
     * How many bytes before the end of the transcript the read starts; tests narrow it.
     */
    tailWindowBytes?: number;
}

/**
 * Reads a transcript's user and Agent text from the start (or, for a very long one, from a tail window), through the
 * same safe, bounded line scanner the Session context reader uses and the same visible-message boundary Session search
 * and title generation use: tool calls, tool output, sidechains, and harness-injected envelopes never reach the
 * result.
 *
 * The result is conversation content. Callers must not log it, persist it in SQLite, or put it in a diagnostic.
 */
export async function readTranscriptConversation(
    location: AgentTranscriptLocation,
    maxRetainedChars: number,
    { tailWindowBytes = MAX_TAIL_WINDOW_BYTES, ...options }: TranscriptConversationOptions = {},
): Promise<TranscriptConversation> {
    let accumulator = new ConversationAccumulator(maxRetainedChars);
    // A size probe only; the scanner still opens the file through its symlink and identity checks.
    let size = 0;
    try {
        ({ size } = await lstat(location.path));
    } catch {
        // A missing file is reported by the scanner's own open below.
    }
    const offset = Math.max(0, size - tailWindowBytes);
    let isTailOnly = offset > 0;
    await scanTranscriptToEnd(
        location,
        // Starting mid-file lands inside a record; the scanner discards up to the next newline.
        { offset, skippingOversizedLine: offset > 0 },
        (line) => {
            if (!line.trim()) return;
            const recordLine =
                line.length > MAX_RECORD_CHARS ? compactInlineMediaPayloads(line) : line;
            let record: unknown;
            try {
                record = JSON.parse(recordLine);
            } catch {
                // A truncated tail or an oversized record the scanner cut short.
                accumulator.interrupt();
                return;
            }
            const message = extractVisibleTranscriptMessage(record);
            if (message) accumulator.add(message);
            else accumulator.interrupt();
        },
        {
            ...options,
            onReset: () => {
                // The provider rewrote the file mid-read; only the rewritten content describes the conversation.
                accumulator = new ConversationAccumulator(maxRetainedChars);
                isTailOnly = false;
                options.onReset?.();
            },
        },
    );
    return {
        messages: accumulator.messages,
        omittedMessageCount: accumulator.omittedMessageCount,
        isTailOnly,
    };
}
