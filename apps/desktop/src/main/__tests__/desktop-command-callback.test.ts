import { connectDesktopToServer } from '@caxri/client/supervise';
import type { DesktopOperation, DesktopTargetPayload } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activeDesktopCommand } from '../desktop-command-scope';
import { createConnection, mockServerRound } from './support/server-connection-harness';

const { superviseModuleMock } = await vi.hoisted(() => import('./support/supervise-module-mock'));

vi.mock('@caxri/client/supervise', () => superviseModuleMock());

type DesktopCommandHandler = (
    operation: DesktopOperation,
    consumeTarget: () => Promise<DesktopTargetPayload>,
) => Promise<unknown>;

const OPEN_IN_EDITOR: DesktopOperation = { kind: 'openInEditor', targetId: 'target-1' };

/**
 * The handler Server Core would dispatch to, taken from the connection rather than from the test, so the guard is
 * exercised exactly where production installs it.
 */
function dispatchedHandler(): DesktopCommandHandler {
    const handler = vi.mocked(connectDesktopToServer).mock.calls.at(-1)?.[2];
    if (!handler) throw new Error('Desktop was never attached to a Caxri Host');
    return handler;
}

function consumeTarget(): Promise<DesktopTargetPayload> {
    return Promise.resolve({} as DesktopTargetPayload);
}

describe('Desktop command callback guard', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    /**
     * Server Core is still waiting for this command's reply, and the request the handler just issued is queued behind
     * that same command. Before the guard, both sides sat there until the 15s Desktop command timeout reported nothing
     * more useful than `Desktop command timed out`.
     */
    it('refuses an ordinary Server request issued from a Desktop command handler', async () => {
        mockServerRound();
        let callback: Promise<unknown> | undefined;
        const { connection, logger } = createConnection({}, () => {
            callback = connection.request('settings.get');
            return callback;
        });
        await connection.start();

        await expect(dispatchedHandler()(OPEN_IN_EDITOR, consumeTarget)).rejects.toMatchObject({
            code: 'INTERNAL',
            message: expect.stringContaining('openInEditor') as string,
        });
        expect(logger.write).toHaveBeenCalledWith(
            'error',
            'server_connection.desktop_command_callback_rejected',
            {
                fields: {
                    method: 'settings.get',
                    operation: 'openInEditor',
                    reason: 'ordinaryRequestFromDesktopCommand',
                },
            },
        );
        await expect(callback).rejects.toMatchObject({ code: 'INTERNAL' });
    });

    /**
     * The failure is a callback, not an overlap. A Renderer request that merely happens while a Desktop command is in
     * flight is ordinary workbench traffic, and refusing it by wall-clock timing would break the window.
     */
    it('leaves a request made outside the handler alone while a command is in flight', async () => {
        mockServerRound();
        const command = Promise.withResolvers<unknown>();
        const { connection, logger } = createConnection({}, () => command.promise);
        await connection.start();

        const dispatched = dispatchedHandler()(OPEN_IN_EDITOR, consumeTarget);
        await expect(connection.request('app.health')).resolves.toBeDefined();
        command.resolve(null);

        await expect(dispatched).resolves.toBeNull();
        expect(logger.write).not.toHaveBeenCalledWith(
            'error',
            'server_connection.desktop_command_callback_rejected',
            expect.anything(),
        );
    });

    it('reports no active command for ordinary Main work', () => {
        expect(activeDesktopCommand()).toBeUndefined();
    });
});
