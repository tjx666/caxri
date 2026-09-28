import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionLaunch } from '../../../domains/terminal';
import {
    cleanupExecutionFixtures,
    createExecution,
    snapshot,
    terminal,
} from './execution-fixtures';

afterEach(cleanupExecutionFixtures);

const launch: TerminalExecutionLaunch = {
    args: [],
    environment: {},
    executable: '/bin/zsh',
    initialSnapshot: null,
    record: terminal,
};

/**
 * Permanent closure versus reusable discard (#1176): only closure tells Terminal Host to drop the ID's generation
 * baseline, and it must reach the Host even when the PTY already exited on its own.
 */
describe('architecture-a3b-terminal-host: Terminal retirement', () => {
    it('retires a closed Terminal by server-scoped ID and discards a failed launch with a scoped stop', async () => {
        const { control, execution } = createExecution();
        await execution.reserve(terminal);
        await execution.start(launch);
        execution.close(terminal.id);
        await vi.waitFor(() => expect(control.requestCount('terminal.retire')).toBe(1));
        expect(control.requests.at(-1)).toEqual({
            request: { method: 'terminal.retire', params: { terminalId: terminal.id } },
            scope: { scope: 'server', capability: 'terminal.lifecycle' },
        });

        const reusable = { ...terminal, id: 'terminal-reusable' };
        await execution.reserve(reusable);
        await execution.start({ ...launch, record: reusable });
        execution.discard(reusable.id);
        await vi.waitFor(() => expect(control.requestCount('terminal.stop')).toBe(1));
        expect(control.requests.at(-1)).toMatchObject({
            request: { method: 'terminal.stop', params: { persistSnapshot: false } },
            scope: { scope: 'terminal', terminalId: reusable.id, ptyGeneration: 1 },
        });
        expect(control.requestCount('terminal.retire')).toBe(1);
    });

    it('retires a Terminal whose PTY already exited only while a Host is running', async () => {
        const { control, execution } = createExecution();
        for (const id of ['terminal-exited', 'terminal-exited-offline']) {
            const record = { ...terminal, id };
            // eslint-disable-next-line no-await-in-loop -- each Terminal exits before the next one launches
            await execution.reserve(record);
            // eslint-disable-next-line no-await-in-loop -- each Terminal exits before the next one launches
            await execution.start({ ...launch, record });
            control.emit({
                type: 'event',
                event: 'terminal.exit',
                identity: {
                    scope: 'terminal',
                    sessionId: record.sessionId,
                    terminalId: id,
                    ptyGeneration: 1,
                },
                exitCode: 0,
                snapshot: { ...snapshot, terminalId: id },
            });
        }

        execution.close('terminal-exited');
        await vi.waitFor(() => expect(control.requestCount('terminal.retire')).toBe(1));

        control.running = false;
        execution.close('terminal-exited-offline');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(control.requestCount('terminal.retire')).toBe(1);
    });

    it('does not send a start whose reservation was closed while it settled', async () => {
        const { control, execution } = createExecution();
        const originalRequest = control.request.bind(control);
        const pendingReserve = Promise.withResolvers<unknown>();
        vi.spyOn(control, 'request').mockImplementation((message, scope, signal) => {
            if (message.method !== 'terminal.reserve')
                return originalRequest(message, scope, signal);
            control.requests.push({ request: message, scope });
            return pendingReserve.promise;
        });
        const reserving = execution.reserve(terminal);
        const starting = execution.start(launch);
        execution.close(terminal.id);
        pendingReserve.resolve({ reserved: true });
        await reserving;

        await expect(starting).rejects.toMatchObject({ code: 'CONFLICT' });
        await vi.waitFor(() => expect(control.requestCount('terminal.retire')).toBe(1));
        expect(control.requestCount('terminal.start')).toBe(0);
    });
});
