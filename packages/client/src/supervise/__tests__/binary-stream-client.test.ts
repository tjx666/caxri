import { MAX_TERMINAL_INPUT_PAYLOAD_LENGTH } from '@caxri/protocol';
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

describe('BinaryStreamClient', () => {
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
