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
    const invokePairedDevice = vi.fn(() => Promise.resolve({ accepted: true }));
    return { invoke, invokePairedDevice, logger: { write } };
}

describe('terminal.send principal routing and audit', () => {
    it.each(['desktop', 'human-cli'] as const)(
        'records %s as the direct owner principal',
        async (principalKind) => {
            const { invoke, invokePairedDevice, logger } = fixture();
            await expect(
                invokeTerminalSend({
                    invoke,
                    invokePairedDevice,
                    logger,
                    parameters,
                    principalKind,
                }),
            ).resolves.toEqual({ accepted: true });
            expect(invoke).toHaveBeenCalledOnce();
            expect(invokePairedDevice).not.toHaveBeenCalled();
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

    it('routes a paired device through its short-reply authority and records its source', async () => {
        const { invoke, invokePairedDevice, logger } = fixture();
        await expect(
            invokeTerminalSend({
                invoke,
                invokePairedDevice,
                logger,
                parameters,
                principalKind: 'paired-device',
            }),
        ).resolves.toEqual({ accepted: true });
        expect(invoke).not.toHaveBeenCalled();
        expect(invokePairedDevice).toHaveBeenCalledOnce();
        expect(logger.write).toHaveBeenCalledWith('info', logEventCatalog.terminal.humanSteer, {
            fields: {
                terminalId: 'terminal-1',
                byteLength: 5,
                enter: true,
                principalKind: 'paired-device',
            },
        });
    });

    it.each(['agent', 'extension'] as const)(
        'rejects %s without invoking or logging',
        async (principalKind) => {
            const { invoke, invokePairedDevice, logger } = fixture();
            await expect(
                invokeTerminalSend({
                    invoke,
                    invokePairedDevice,
                    logger,
                    parameters,
                    principalKind,
                }),
            ).rejects.toMatchObject({ code: 'FORBIDDEN' });
            expect(invoke).not.toHaveBeenCalled();
            expect(invokePairedDevice).not.toHaveBeenCalled();
            expect(logger.write).not.toHaveBeenCalled();
        },
    );
});
