import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { invokeTerminalSend } from '../terminal-send';

const parameters = {
    terminalId: 'terminal-1',
    text: 'reply',
    enter: true,
    attentionEpoch: 3,
};

function fixture() {
    const write = vi.fn<StructuredLogger['write']>();
    const invoke = vi.fn(() => Promise.resolve({ accepted: true }));
    return { invoke, logger: { write } };
}

describe('terminal.send principal routing and audit', () => {
    it.each(['desktop', 'human-cli'] as const)(
        'records %s as the direct owner principal',
        async (principalKind) => {
            const { invoke, logger } = fixture();
            await expect(
                invokeTerminalSend({
                    invoke,
                    logger,
                    parameters,
                    principalKind,
                }),
            ).resolves.toEqual({ accepted: true });
            expect(invoke).toHaveBeenCalledOnce();
            expect(logger.write).toHaveBeenCalledWith('info', logEventCatalog.terminal.humanSteer, {
                fields: {
                    terminalId: 'terminal-1',
                    byteLength: 5,
                    enter: true,
                    principalKind,
                },
            });
        },
    );

    it('rejects paired device Terminal steering', async () => {
        const { invoke, logger } = fixture();
        await expect(
            invokeTerminalSend({
                invoke,
                logger,
                parameters,
                principalKind: 'paired-device',
            }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(invoke).not.toHaveBeenCalled();
        expect(logger.write).not.toHaveBeenCalled();
    });

    it.each(['agent', 'extension'] as const)(
        'rejects %s without invoking or logging',
        async (principalKind) => {
            const { invoke, logger } = fixture();
            await expect(
                invokeTerminalSend({
                    invoke,
                    logger,
                    parameters,
                    principalKind,
                }),
            ).rejects.toMatchObject({ code: 'FORBIDDEN' });
            expect(invoke).not.toHaveBeenCalled();
            expect(logger.write).not.toHaveBeenCalled();
        },
    );
});
