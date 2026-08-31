import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
    Notification: class {},
}));
vi.mock('electron', () => electronMock);

import { activateAgentNotificationSession } from '../agent-notification-runtime';
import type { DesktopServerConnection } from '../server-connection';

function harness(sessions: Array<{ archivedAt?: number; id: string }>) {
    const calls: string[] = [];
    const focusMainWindow = vi.fn(() => {
        calls.push('focus');
        return Promise.resolve({} as never);
    });
    const request = vi.fn((method: string) => {
        calls.push(method);
        if (method === 'app.bootstrap') return Promise.resolve({ sessions });
        if (method === 'session.select') return Promise.resolve({});
        return Promise.reject(new Error(`Unexpected method: ${method}`));
    });
    return {
        calls,
        focusMainWindow,
        options: {
            focusMainWindow,
            logger: () => {},
            supervisor: { request } as unknown as DesktopServerConnection,
        },
        request,
    };
}

describe('Agent notification activation', () => {
    beforeEach(() => vi.clearAllMocks());

    it('focuses Caxri before selecting the exact active Session', async () => {
        const test = harness([{ id: 'session-1' }]);

        await activateAgentNotificationSession(test.options, 'session-1');

        expect(test.calls).toEqual(['focus', 'app.bootstrap', 'session.select']);
        expect(test.request).toHaveBeenLastCalledWith('session.select', {
            sessionId: 'session-1',
        });
    });

    it.each([
        ['deleted', []],
        ['archived', [{ id: 'session-1', archivedAt: 10 }]],
    ])('focuses Caxri without changing selection for a %s Session', async (_state, sessions) => {
        const test = harness(sessions);

        await activateAgentNotificationSession(test.options, 'session-1');

        expect(test.calls).toEqual(['focus', 'app.bootstrap']);
        expect(test.request).not.toHaveBeenCalledWith('session.select', expect.anything());
    });
});
