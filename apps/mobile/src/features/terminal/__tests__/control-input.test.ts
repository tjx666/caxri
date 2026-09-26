import { describe, expect, it, vi } from 'vitest';

import { chunkTerminalText, sendTerminalControlInput } from '../control-input';

describe('mobile Terminal control input', () => {
    it('sends exact key and typed bytes through one fenced method', async () => {
        const request = vi.fn(() => Promise.resolve(null));
        const target = {
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            expectedGeneration: 3,
        };
        await sendTerminalControlInput(request, target, '\u{1B}[B');
        await sendTerminalControlInput(request, target, 'hello\nworld');
        expect(request).toHaveBeenNthCalledWith(1, 'mobile.terminal.input', {
            ...target,
            data: '\u{1B}[B',
        });
        expect(request).toHaveBeenNthCalledWith(2, 'mobile.terminal.input', {
            ...target,
            data: 'hello\nworld',
        });
    });

    it('rejects empty and oversized data without touching the Server', async () => {
        const request = vi.fn(() => Promise.resolve(null));
        const target = {
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            expectedGeneration: 3,
        };
        await expect(sendTerminalControlInput(request, target, '')).rejects.toThrow();
        await expect(
            sendTerminalControlInput(request, target, '界'.repeat(3_000)),
        ).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });

    it('chunks serialized screen data without splitting Unicode surrogate pairs', () => {
        const value = `${'a'.repeat(12 * 1_024 - 1)}😀end`;
        const chunks = chunkTerminalText(value);
        expect(chunks.join('')).toBe(value);
        expect(chunks.every((chunk) => chunk.isWellFormed())).toBe(true);
        const independentlyEncoded = chunks.map((chunk) => new TextEncoder().encode(chunk));
        const encodedBytes = Uint8Array.from(independentlyEncoded.flatMap((bytes) => [...bytes]));
        expect(new TextDecoder().decode(encodedBytes)).toBe(value);
        expect(chunks.every((chunk) => chunk.length <= 12 * 1_024)).toBe(true);
    });
});
