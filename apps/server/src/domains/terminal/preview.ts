import type { TerminalPreview } from '@caxri/protocol';
import { CaxriError, MAX_TERMINAL_PREVIEW_BYTES } from '@caxri/protocol';

import type { TerminalExecutionPort } from './execution-port';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function boundedUtf8Tail(value: string): { content: string; truncated: boolean } {
    const bytes = textEncoder.encode(value);
    if (bytes.length <= MAX_TERMINAL_PREVIEW_BYTES) return { content: value, truncated: false };
    let start = bytes.length - MAX_TERMINAL_PREVIEW_BYTES;
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
    return { content: textDecoder.decode(bytes.subarray(start)), truncated: true };
}

export async function terminalPreview(
    execution: TerminalExecutionPort,
    terminalId: string,
    hasTerminal: boolean,
): Promise<TerminalPreview> {
    if (!hasTerminal) throw new CaxriError('NOT_FOUND', 'Terminal not found');
    const updatedAt = Date.now();
    if (execution.processId(terminalId) === undefined)
        return {
            terminalId,
            availability: 'stopped',
            content: '',
            truncated: false,
            updatedAt,
        };
    if (!execution.textTail)
        return {
            terminalId,
            availability: 'unavailable',
            content: '',
            truncated: false,
            updatedAt,
        };
    try {
        const source = await execution.textTail(terminalId, MAX_TERMINAL_PREVIEW_BYTES + 1);
        if (source === null)
            return {
                terminalId,
                availability: 'unavailable',
                content: '',
                truncated: false,
                updatedAt,
            };
        const bounded = boundedUtf8Tail(source);
        return {
            terminalId,
            availability: 'live',
            ...bounded,
            truncated: bounded.truncated || source.length > MAX_TERMINAL_PREVIEW_BYTES,
            updatedAt,
        };
    } catch {
        return {
            terminalId,
            availability: 'unavailable',
            content: '',
            truncated: false,
            updatedAt,
        };
    }
}
