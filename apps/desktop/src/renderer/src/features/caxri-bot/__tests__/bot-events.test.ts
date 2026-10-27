import type { BotIdentity, ServerEvent } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { botEventEffect } from '../bot-events';

const identity: BotIdentity = {
    projectId: 'bot-project',
    sessionId: 'bot-session',
    terminalId: 'bot-terminal',
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

describe('botEventEffect', () => {
    it('re-reads everything on a full state change', () => {
        expect(
            botEventEffect(event('state.changed', { kind: 'full', reason: 'unknown' }), identity),
        ).toEqual({
            board: true,
            ensure: false,
            inbox: false,
            openPalette: false,
            pullRequestSessionIds: [],
            reattach: false,
            revealInbox: false,
            snapshot: true,
        });
    });

    it("re-reads the snapshot only when a record change names Caxri Bot's own rows", () => {
        expect(botEventEffect(records(['bot-session']), identity).snapshot).toBe(true);
        expect(botEventEffect(records([], ['bot-terminal']), identity).snapshot).toBe(true);
        expect(botEventEffect(records(['other-session'], ['other-terminal']), identity)).toEqual({
            board: true,
            ensure: false,
            inbox: false,
            openPalette: false,
            pullRequestSessionIds: [],
            reattach: false,
            revealInbox: false,
            snapshot: false,
        });
    });

    it('treats a record change before the first snapshot as possibly its own', () => {
        expect(botEventEffect(records(['other-session']), undefined).snapshot).toBe(true);
    });

    /**
     * A new Server generation took Caxri Bot's PTY with it and restores only the Workbench's selected Session, so the
     * window has to start its Caxri Bot again; a reconnect to the same Server only lost PTY bytes.
     */
    it.each([
        ['a Server restart', event('runtime.status', { restartCount: 1, status: 'ready' }), true],
        [
            'a reconnect to a replaced Server',
            event('host.connectionChanged', {
                attempt: 1,
                downtimeMs: 10,
                isHostReplaced: true,
                status: 'reconnected',
            }),
            true,
        ],
        [
            'a reconnect to the same Server',
            event('host.connectionChanged', {
                attempt: 1,
                downtimeMs: 10,
                isHostReplaced: false,
                status: 'reconnected',
            }),
            false,
        ],
    ])('re-attaches after %s', (_, serverEvent, shouldEnsure) => {
        expect(botEventEffect(serverEvent, identity)).toEqual({
            board: true,
            ensure: shouldEnsure,
            inbox: true,
            openPalette: false,
            pullRequestSessionIds: [],
            reattach: true,
            revealInbox: false,
            snapshot: true,
        });
    });

    it('waits out a restart and leaves a profile takeover to the Workbench window', () => {
        const none = {
            board: false,
            ensure: false,
            inbox: false,
            openPalette: false,
            pullRequestSessionIds: [],
            reattach: false,
            revealInbox: false,
            snapshot: false,
        };
        expect(
            botEventEffect(
                event('runtime.status', { restartCount: 1, status: 'restarting' }),
                identity,
            ),
        ).toEqual(none);
        expect(
            botEventEffect(event('host.connectionChanged', { status: 'replaced' }), identity),
        ).toEqual(none);
    });

    it('follows Settings, theme, and keybinding changes unless they failed to load', () => {
        for (const name of ['settings.changed', 'theme.changed', 'keybindings.changed'] as const) {
            expect(botEventEffect(event(name, {}), identity)).toEqual({
                board: false,
                ensure: false,
                inbox: false,
                openPalette: false,
                pullRequestSessionIds: [],
                reattach: false,
                revealInbox: false,
                snapshot: true,
            });
            expect(botEventEffect(event(name, { error: 'bad json' }), identity).snapshot).toBe(
                false,
            );
        }
    });

    /**
     * A pull-request change names its Sessions, so the board patches those rows instead of refetching every row (issue
     * caxri#1411).
     */
    it('patches only the named rows when pull requests change', () => {
        expect(
            botEventEffect(
                event('sessionPullRequests.changed', { sessionIds: ['session-1', 'session-2'] }),
                identity,
            ),
        ).toEqual({
            board: false,
            ensure: false,
            inbox: false,
            openPalette: false,
            pullRequestSessionIds: ['session-1', 'session-2'],
            reattach: false,
            revealInbox: false,
            snapshot: false,
        });
    });

    it('re-reads the Inbox, and only the Inbox, when it changes', () => {
        expect(
            botEventEffect(event('botInbox.changed', { itemIds: ['item-1'] }), identity),
        ).toEqual({
            board: false,
            ensure: false,
            inbox: true,
            openPalette: false,
            pullRequestSessionIds: [],
            reattach: false,
            revealInbox: false,
            snapshot: false,
        });
    });

    it('opens the Command Palette, and only that, when its shortcut was typed in this window', () => {
        expect(
            botEventEffect(event('caxriBot.commandPaletteRequested', {}), identity),
        ).toMatchObject({ board: false, inbox: false, openPalette: true, snapshot: false });
    });

    it('opens the Inbox, and only that, when the status bar chip asks for it', () => {
        expect(botEventEffect(event('caxriBot.inboxRequested', {}), identity)).toEqual({
            board: false,
            ensure: false,
            inbox: false,
            openPalette: false,
            pullRequestSessionIds: [],
            reattach: false,
            revealInbox: true,
            snapshot: false,
        });
    });

    it("mirrors this window's fullscreen state and ignores the Workbench window's", () => {
        expect(
            botEventEffect(
                event('window.fullScreen', { window: 'caxriBot', isFullScreen: true }),
                identity,
            ).isFullScreen,
        ).toBe(true);
        expect(
            botEventEffect(
                event('window.fullScreen', { window: 'workbench', isFullScreen: true }),
                identity,
            ).isFullScreen,
        ).toBeUndefined();
    });

    it('ignores UI commands, which belong to the Workbench window', () => {
        const none = {
            board: false,
            ensure: false,
            inbox: false,
            openPalette: false,
            pullRequestSessionIds: [],
            reattach: false,
            revealInbox: false,
            snapshot: false,
        };
        expect(
            botEventEffect(event('command.execute', { command: 'palette.show' }), identity),
        ).toEqual(none);
        expect(
            botEventEffect(event('desktop.openRequested', { sessionId: 'session-1' }), identity),
        ).toEqual(none);
    });
});
