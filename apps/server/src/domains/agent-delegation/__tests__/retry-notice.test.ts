import { formatDelegationRetryNotice } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { StoredAgentDelegation } from '../../db';
import { createRetryNotice } from '../retry-notice';

const failed = {
    receipt: { delegationId: 'failed-1', callerTerminalId: 'terminal-1' },
} as unknown as StoredAgentDelegation;

function setup(overrides: Record<string, unknown> = {}, isCallerLive = () => true) {
    const write = vi.fn<(...arguments_: unknown[]) => boolean>(() => true);
    const logger = { write: vi.fn() };
    const options = {
        database: { getTerminal: () => ({ id: 'terminal-1' }) },
        currentLaunchId: () => 'launch-1',
        write,
        logger,
        ...overrides,
    } as unknown as Parameters<typeof createRetryNotice>[0];
    return { notify: createRetryNotice(options, isCallerLive), write, logger };
}

const outcomeLogged = (logger: { write: ReturnType<typeof vi.fn> }) =>
    logger.write.mock.calls.map(
        (call) => (call[2] as { fields: { outcome: string } }).fields.outcome,
    );

describe('createRetryNotice', () => {
    it('skips the notice when the caller is no longer the live Endpoint generation', () => {
        const { notify, write, logger } = setup({}, () => false);

        expect(notify(failed, 'retry-1')).toBe('caller_gone');
        expect(write).not.toHaveBeenCalled();
        expect(outcomeLogged(logger)).toEqual(['caller_gone']);
    });

    it('writes the fixed notice to the caller pinned to its current launch', () => {
        const { notify, write, logger } = setup();

        expect(notify(failed, 'retry-1')).toBe('sent');
        expect(write).toHaveBeenCalledWith(
            'terminal-1',
            'launch-1',
            `\u{1B}[200~${formatDelegationRetryNotice('failed-1', 'retry-1')}\u{1B}[201~\r`,
            expect.any(Function),
        );
        expect(outcomeLogged(logger)).toEqual(['sent']);
    });

    it('sends once per retry', () => {
        const { notify, write, logger } = setup();

        notify(failed, 'retry-1');

        expect(notify(failed, 'retry-1')).toBe('duplicate');
        expect(write).toHaveBeenCalledTimes(1);
        expect(outcomeLogged(logger)).toEqual(['sent', 'duplicate']);
    });

    it('reports a caller whose Terminal is gone', () => {
        const { notify, write } = setup({ database: { getTerminal: () => {} } });

        expect(notify(failed, 'retry-1')).toBe('caller_gone');
        expect(write).not.toHaveBeenCalled();
    });

    it('reports a caller without a running Agent', () => {
        const { notify, write } = setup({ currentLaunchId: () => {} });

        expect(notify(failed, 'retry-1')).toBe('agent_not_running');
        expect(write).not.toHaveBeenCalled();
    });

    it('reports a write the Server refuses', () => {
        const { notify } = setup({ write: () => false });

        expect(notify(failed, 'retry-1')).toBe('rejected');
    });

    it('logs a write the Host refuses after admitting it', () => {
        const { notify, write, logger } = setup();
        notify(failed, 'retry-1');

        (write.mock.calls[0][3] as (isDelivered: boolean) => void)(false);

        expect(outcomeLogged(logger)).toEqual(['sent', 'rejected']);
    });

    it('never throws when delivery throws', () => {
        const { notify } = setup({
            write: () => {
                throw new Error('boom');
            },
        });

        expect(notify(failed, 'retry-1')).toBe('failed');
    });
});
