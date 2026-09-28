import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionLaunch } from '../../../domains/terminal';
import type { FakeTerminalHostControl } from './execution-fixtures';
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
 * Holds every `terminal.stop` until the returned resolver runs, the way Terminal Host holds one while it waits for
 * managed Agent cancellation.
 */
function holdStop(control: FakeTerminalHostControl): PromiseWithResolvers<unknown> {
    const originalRequest = control.request.bind(control);
    const pendingStop = Promise.withResolvers<unknown>();
    vi.spyOn(control, 'request').mockImplementation((message, scope, signal) => {
        if (message.method !== 'terminal.stop') return originalRequest(message, scope, signal);
        control.requests.push({ request: message, scope });
        return pendingStop.promise;
    });
    return pendingStop;
}

/**
 * Terminal Host seals a generation when it admits `terminal.stop` and holds the stop while a managed Agent cancels
 * (#1425). Server Core must neither race the next reservation past that stop nor turn keystrokes typed meanwhile into
 * Host refusals.
 */
describe('architecture-a3b-terminal-host: stopping a generation', () => {
    it('reserves the next generation only after the failed launch discard reaches Terminal Host', async () => {
        const { control, execution } = createExecution();
        await execution.reserve(terminal);
        await execution.start(launch);
        const pendingStop = holdStop(control);

        execution.discard(terminal.id);
        await vi.waitFor(() => expect(control.requestCount('terminal.stop')).toBe(1));
        const reserving = execution.reserve(terminal);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(control.requestCount('terminal.reserve')).toBe(1);

        pendingStop.resolve({ snapshot: null, stopped: true });
        await reserving;
        expect(control.requests.map(({ request }) => request.method).slice(-2)).toEqual([
            'terminal.stop',
            'terminal.reserve',
        ]);
        expect(control.requests.at(-1)!.scope).toMatchObject({ ptyGeneration: 2 });
    });

    it('drops keystrokes and keeps only the view size while a restart barrier stops the PTY', async () => {
        const { control, execution } = createExecution();
        await execution.attach(terminal.id, { cols: 80, rows: 24 });
        await execution.reserve(terminal);
        await execution.start(launch);
        const pendingStop = holdStop(control);

        const stopping = execution.restartBarrier(terminal.id);
        await vi.waitFor(() => expect(control.requestCount('terminal.stop')).toBe(1));
        expect(execution.write(terminal.id, 'typed during restart')).toBe(false);
        await expect(execution.writeAcknowledged(terminal.id, 'acknowledged')).resolves.toBe(false);
        expect(execution.resize(terminal.id, 132, 43)).toBe(true);
        pendingStop.resolve({ snapshot, stopped: true });
        await expect(stopping).resolves.toEqual(snapshot);
        expect(control.requestCount('terminal.input')).toBe(0);
        expect(control.requestCount('terminal.resize')).toBe(0);

        await execution.reserve(terminal);
        expect(control.requests.at(-1)).toMatchObject({
            request: { method: 'terminal.attach', params: { size: { cols: 132, rows: 43 } } },
            scope: { ptyGeneration: 2 },
        });
    });
});
