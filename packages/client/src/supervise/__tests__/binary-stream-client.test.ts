import { CaxriError, MAX_TERMINAL_INPUT_PAYLOAD_LENGTH } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { BinaryStreamClient } from '../binary-stream-client';

function createClient() {
    const client = new BinaryStreamClient({
        emitEvent: vi.fn(),
        endpoint: { host: '127.0.0.1', path: '/control', port: 1, protocol: 'ws' },
        issueTicket: () => Promise.reject(new Error('Stable attachment must not reauthorize')),
        onTerminalTransportFailure: vi.fn(),
        timeoutMs: 1_000,
    });
    const terminals = Reflect.get(client, 'terminals') as Map<
        string,
        { input(payload: Uint8Array): Promise<null> }
    >;
    return { client, terminals };
}

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
    try {
        return await operation;
    } catch (error) {
        return error;
    }
}

describe('BinaryStreamClient', () => {
    it.each(['TIMEOUT', 'UNAVAILABLE', 'FORBIDDEN', 'CANCELLED'] as const)(
        'bounds attachment recovery and preserves the final error: %s',
        async (code) => {
            vi.useFakeTimers();
            const error = new CaxriError(code, 'Synthetic attachment failure');
            const issueTicket = vi.fn<(id: string) => Promise<never>>().mockRejectedValue(error);
            const client = new BinaryStreamClient({
                emitEvent: vi.fn(),
                endpoint: { host: '127.0.0.1', path: '/control', port: 1, protocol: 'ws' },
                issueTicket,
                onTerminalTransportFailure: vi.fn(),
                timeoutMs: 1_000,
            });
            try {
                const result = captureFailure(
                    client.request('request-1', 'terminal.attach', {
                        terminalId: 'terminal-1',
                    }),
                );
                await vi.runAllTimersAsync();
                await expect(result).resolves.toBe(error);
                const expectedAttempts = code === 'TIMEOUT' || code === 'UNAVAILABLE' ? 3 : 1;
                expect(issueTicket).toHaveBeenCalledTimes(expectedAttempts);
                expect(new Set(issueTicket.mock.calls.map(([id]) => id)).size).toBe(
                    expectedAttempts,
                );
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                client.close();
                vi.useRealTimers();
            }
        },
    );

    it.each(['detach', 'terminal-close', 'disconnect'] as const)(
        'cancels attachment recovery during backoff: %s',
        async (action) => {
            vi.useFakeTimers();
            const issueTicket = vi
                .fn<(id: string) => Promise<never>>()
                .mockRejectedValue(new CaxriError('TIMEOUT', 'Synthetic timeout'));
            const client = new BinaryStreamClient({
                emitEvent: vi.fn(),
                endpoint: { host: '127.0.0.1', path: '/control', port: 1, protocol: 'ws' },
                issueTicket,
                onTerminalTransportFailure: vi.fn(),
                timeoutMs: 1_000,
            });
            try {
                const result = captureFailure(
                    client.request('request-1', 'terminal.attach', {
                        terminalId: 'terminal-1',
                    }),
                );
                await vi.advanceTimersByTimeAsync(0);
                expect(issueTicket).toHaveBeenCalledTimes(1);
                expect(vi.getTimerCount()).toBe(1);
                if (action === 'detach') client.beginTerminalDetach('terminal-1').complete();
                else if (action === 'terminal-close') client.closeTerminal('terminal-1');
                else client.close();
                await expect(result).resolves.toMatchObject({ code: 'CANCELLED' });
                await vi.runAllTimersAsync();
                expect(issueTicket).toHaveBeenCalledTimes(1);
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                client.close();
                vi.useRealTimers();
            }
        },
    );

    it('pipelines input through an established persistent Terminal stream', async () => {
        const first = Promise.withResolvers<null>();
        const second = Promise.withResolvers<null>();
        const input = vi
            .fn<(payload: Uint8Array) => Promise<null>>()
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise);
        const { client, terminals } = createClient();
        terminals.set('terminal-1', { input });

        try {
            const firstRequest = client.request('request-1', 'terminal.input', {
                data: 'first',
                terminalId: 'terminal-1',
            });
            await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(1));

            const secondRequest = client.request('request-2', 'terminal.input', {
                data: 'second',
                terminalId: 'terminal-1',
            });
            await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(2));

            expect(input.mock.calls.map(([payload]) => new TextDecoder().decode(payload))).toEqual([
                'first',
                'second',
            ]);
            first.resolve(null);
            second.resolve(null);
            await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([null, null]);
        } finally {
            first.resolve(null);
            second.resolve(null);
            client.close();
        }
    });

    it('retains the shared input byte budget until a pipelined acknowledgement arrives', async () => {
        const pending = Promise.withResolvers<null>();
        const input = vi
            .fn<(payload: Uint8Array) => Promise<null>>()
            .mockImplementationOnce(() => pending.promise)
            .mockResolvedValue(null);
        const { client, terminals } = createClient();
        terminals.set('terminal-1', { input });
        const largeInput = '€'.repeat(MAX_TERMINAL_INPUT_PAYLOAD_LENGTH);

        try {
            const firstRequest = client.request('request-1', 'terminal.input', {
                data: largeInput,
                terminalId: 'terminal-1',
            });
            await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(1));

            await expect(
                client.request('request-2', 'terminal.input', {
                    data: largeInput,
                    terminalId: 'terminal-1',
                }),
            ).rejects.toMatchObject({ code: 'CAPACITY' });
            expect(input).toHaveBeenCalledTimes(1);

            pending.resolve(null);
            await expect(firstRequest).resolves.toBeNull();
            await expect(
                client.request('request-3', 'terminal.input', {
                    data: largeInput,
                    terminalId: 'terminal-1',
                }),
            ).resolves.toBeNull();
            expect(input).toHaveBeenCalledTimes(2);
        } finally {
            pending.resolve(null);
            client.close();
        }
    });
});
