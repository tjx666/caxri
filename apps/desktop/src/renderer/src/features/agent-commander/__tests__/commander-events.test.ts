import type { CommanderIdentity, ServerEvent } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { commanderEventEffect } from '../commander-events';

const identity: CommanderIdentity = {
    projectId: 'commander-project',
    sessionId: 'commander-session',
    terminalId: 'commander-terminal',
};

/**
 * Events are built as the wire delivers them; the cast only spares each case the envelope fields this mapping never
 * reads.
 */
function event(name: ServerEvent['event'], payload: unknown): ServerEvent {
    return { event: name, payload } as ServerEvent;
}

function records(sessionIds: string[], terminalIds: string[] = []): ServerEvent {
    return event('state.changed', { kind: 'records', sessionIds, terminalIds });
}

describe('commanderEventEffect', () => {
    it('re-reads everything on a full state change', () => {
        expect(
            commanderEventEffect(
                event('state.changed', { kind: 'full', reason: 'unknown' }),
                identity,
            ),
        ).toEqual({ board: true, reattach: false, snapshot: true });
    });

    it("re-reads the snapshot only when a record change names the Commander's own rows", () => {
        expect(commanderEventEffect(records(['commander-session']), identity).snapshot).toBe(true);
        expect(commanderEventEffect(records([], ['commander-terminal']), identity).snapshot).toBe(
            true,
        );
        expect(
            commanderEventEffect(records(['other-session'], ['other-terminal']), identity),
        ).toEqual({ board: true, reattach: false, snapshot: false });
    });

    it('treats a record change before the first snapshot as possibly its own', () => {
        expect(commanderEventEffect(records(['other-session']), undefined).snapshot).toBe(true);
    });

    it('re-attaches after the Server comes back', () => {
        expect(
            commanderEventEffect(
                event('runtime.status', { restartCount: 1, status: 'ready' }),
                identity,
            ),
        ).toEqual({ board: true, reattach: true, snapshot: true });
        expect(
            commanderEventEffect(
                event('host.connectionChanged', {
                    attempt: 1,
                    downtimeMs: 10,
                    isHostReplaced: false,
                    status: 'reconnected',
                }),
                identity,
            ),
        ).toEqual({ board: true, reattach: true, snapshot: true });
    });

    it('waits out a restart and leaves a profile takeover to the Workbench window', () => {
        const none = { board: false, reattach: false, snapshot: false };
        expect(
            commanderEventEffect(
                event('runtime.status', { restartCount: 1, status: 'restarting' }),
                identity,
            ),
        ).toEqual(none);
        expect(
            commanderEventEffect(event('host.connectionChanged', { status: 'replaced' }), identity),
        ).toEqual(none);
    });

    it('follows Settings, theme, and keybinding changes unless they failed to load', () => {
        for (const name of ['settings.changed', 'theme.changed', 'keybindings.changed'] as const) {
            expect(commanderEventEffect(event(name, {}), identity)).toEqual({
                board: false,
                reattach: false,
                snapshot: true,
            });
            expect(
                commanderEventEffect(event(name, { error: 'bad json' }), identity).snapshot,
            ).toBe(false);
        }
    });

    it('refreshes the board when pull requests change', () => {
        expect(
            commanderEventEffect(
                event('sessionPullRequests.changed', { sessionIds: ['session-1'] }),
                identity,
            ),
        ).toEqual({ board: true, reattach: false, snapshot: false });
    });

    it('ignores UI commands, which belong to the Workbench window', () => {
        const none = { board: false, reattach: false, snapshot: false };
        expect(
            commanderEventEffect(event('command.execute', { command: 'palette.show' }), identity),
        ).toEqual(none);
        expect(
            commanderEventEffect(
                event('desktop.openRequested', { sessionId: 'session-1' }),
                identity,
            ),
        ).toEqual(none);
    });
});
