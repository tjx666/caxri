// oxlint-disable typescript/require-await, typescript/unbound-method -- Async Host mocks and Vitest method assertions have no this binding.
import type { TerminalSnapshot } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionPort } from '../../../../domains/terminal';
import { MobileTerminalObserver } from '../terminal-observer';

const snapshot: TerminalSnapshot = {
    terminalId: 'terminal-1',
    encodingVersion: 1,
    cols: 80,
    rows: 24,
    lineCount: 10,
    byteCount: 3,
    payload: 'old',
    updatedAt: 1_788_106_000_000,
};

describe('ambiguous observe failures', () => {
    it('releases the holder once when the first observe times out, and close() adds nothing', async () => {
        const port = {
            observe: vi.fn(async () => {
                throw new CaxriError('TIMEOUT', 'Host observe timed out');
            }),
            unobserve: vi.fn(async () => {}),
        } as unknown as TerminalExecutionPort;
        const observer = new MobileTerminalObserver({
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            holderId: 'connection-1:subscription-1',
            port,
            authorize: async () => {},
            reserve: () => true,
            release: vi.fn(),
            send: async () => {},
            remove: vi.fn(),
            terminate: vi.fn(),
        });
        await expect(observer.start()).rejects.toThrow('Host observe timed out');
        await observer.close();
        expect(port.unobserve).toHaveBeenCalledExactlyOnceWith(
            'terminal-1',
            'connection-1:subscription-1',
        );
    });

    it('releases the holder when a resize refresh observe fails', async () => {
        const port = {
            observe: vi
                .fn()
                .mockResolvedValueOnce({ snapshot, nextSequence: 3, generation: 1 })
                .mockRejectedValueOnce(new CaxriError('TIMEOUT', 'Host observe timed out')),
            unobserve: vi.fn(async () => {}),
            releaseTakeOver: vi.fn(async () => {}),
        } as unknown as TerminalExecutionPort;
        const remove = vi.fn();
        const observer = new MobileTerminalObserver({
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            holderId: 'connection-1:subscription-1',
            port,
            authorize: async () => {},
            reserve: () => true,
            release: vi.fn(),
            send: async () => {},
            remove,
            terminate: vi.fn(),
        });
        await observer.start();
        observer.activate();
        observer.accept({
            type: 'gap',
            terminalId: 'terminal-1',
            generation: 1,
            sequence: 3,
            reason: 'resize',
        });
        await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
        await observer.close();
        // One unobserve before the refresh observe, one for the failed refresh observe; close() adds none.
        expect(port.unobserve).toHaveBeenCalledTimes(2);
        expect(port.observe).toHaveBeenCalledTimes(2);
    });

    it('reports a closed reason when the best-effort release also fails', async () => {
        const port = {
            observe: vi.fn(async () => {
                throw new CaxriError('CANCELLED', 'cancelled');
            }),
            unobserve: vi.fn(async () => {
                throw new Error('Host stopped');
            }),
        } as unknown as TerminalExecutionPort;
        const reportTeardownFailure = vi.fn();
        const observer = new MobileTerminalObserver({
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            holderId: 'connection-1:subscription-1',
            port,
            authorize: async () => {},
            reserve: () => true,
            release: vi.fn(),
            send: async () => {},
            remove: vi.fn(),
            reportTeardownFailure,
            terminate: vi.fn(),
        });
        await expect(observer.start()).rejects.toThrow('cancelled');
        expect(reportTeardownFailure).toHaveBeenCalledExactlyOnceWith('start-observe-failed');
    });
});
