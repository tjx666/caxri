export interface TerminalOutputQueue {
    push(chunks: string[]): boolean;
    shift(): string | undefined;
    readonly length: number;
    clear(): void;
}

const utf8ByteLength = (value: string): number => {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.codePointAt(index) ?? 0;
        if (code <= 0x7f) bytes += 1;
        else if (code <= 0x7ff) bytes += 2;
        else if (code <= 0xffff) bytes += 3;
        else {
            bytes += 4;
            index += 1;
        }
    }
    return bytes;
};

/**
 * Keeps WebView-bound PTY output within a fixed byte budget while the bridge drains.
 */
export const createTerminalOutputQueue = (maxBytes: number): TerminalOutputQueue => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
        throw new RangeError('Terminal output capacity must be a nonnegative safe integer');

    let queuedBytes = 0;
    let entries: Array<{ text: string; bytes: number }> = [];
    return {
        push: (chunks) => {
            const incoming: Array<{ text: string; bytes: number }> = [];
            let incomingBytes = 0;
            for (const text of chunks) {
                if (!text) continue;
                const bytes = utf8ByteLength(text);
                if (bytes > maxBytes - queuedBytes - incomingBytes) return false;
                incoming.push({ text, bytes });
                incomingBytes += bytes;
            }
            for (const entry of incoming) entries.push(entry);
            queuedBytes += incomingBytes;
            return true;
        },
        shift: () => {
            const entry = entries.shift();
            if (!entry) return;
            queuedBytes -= entry.bytes;
            return entry.text;
        },
        get length() {
            return entries.length;
        },
        clear: () => {
            entries = [];
            queuedBytes = 0;
        },
    };
};
