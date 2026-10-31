import type { MobileSessionMenuState } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { sessionAgentMenu } from '../session-agent-menu';
import type { MobileSessionItem } from '../session-model';

type Session = Pick<MobileSessionItem, 'createdBySessionId' | 'primaryTerminal'>;

const withAgent = (lastProcessState: string): Session =>
    ({
        createdBySessionId: undefined,
        primaryTerminal: { id: 'terminal-1', lastProcessState, provider: 'claude' },
    }) as unknown as Session;

const menuState = (overrides: Partial<MobileSessionMenuState> = {}): MobileSessionMenuState => ({
    conversations: [],
    hasConversation: true,
    isBotManaged: false,
    ...overrides,
});

const none: ReadonlySet<string> = new Set();

describe('sessionAgentMenu', () => {
    it('hides the Agent entries for a Session without an Agent', () => {
        const session = {
            createdBySessionId: undefined,
            primaryTerminal: { id: 'shell', lastProcessState: 'running', provider: undefined },
        } as unknown as Session;
        expect(sessionAgentMenu(session, menuState(), none)).toMatchObject({
            restart: undefined,
            detach: undefined,
        });
    });

    it('offers Detach for a running Agent and Resume for a detached one, which also blocks Restart', () => {
        expect(sessionAgentMenu(withAgent('running'), menuState(), none)).toMatchObject({
            restart: { blocker: undefined },
            detach: { action: 'detach', canDetach: true },
        });
        expect(sessionAgentMenu(withAgent('exited'), menuState(), none).detach).toEqual({
            action: 'detach',
            canDetach: false,
        });
        expect(sessionAgentMenu(withAgent('detached'), menuState(), none)).toMatchObject({
            restart: { blocker: 'detached' },
            detach: { action: 'resume' },
        });
    });

    it('blocks Restart only once the menu state says there is no conversation to resume', () => {
        expect(sessionAgentMenu(withAgent('running'), undefined, none).restart).toEqual({
            blocker: undefined,
        });
        expect(
            sessionAgentMenu(withAgent('running'), menuState({ hasConversation: false }), none)
                .restart,
        ).toEqual({ blocker: 'noConversation' });
    });

    it('picks Hand Over or Take Back from the menu state and hides both until it is read', () => {
        expect(sessionAgentMenu(withAgent('running'), undefined, none).bot).toBeUndefined();
        expect(sessionAgentMenu(withAgent('running'), menuState(), none).bot).toBe('handOver');
        expect(
            sessionAgentMenu(withAgent('running'), menuState({ isBotManaged: true }), none).bot,
        ).toBe('takeBack');
    });

    it('offers Reopen only with a closed conversation to bring back', () => {
        expect(sessionAgentMenu(withAgent('running'), menuState(), none).canReopen).toBe(false);
        expect(
            sessionAgentMenu(
                withAgent('running'),
                menuState({
                    conversations: [{ provider: 'codex', agentSessionId: 'old', boundAt: 1 }],
                }),
                none,
            ).canReopen,
        ).toBe(true);
    });

    it('links the creating Session only while the phone lists it', () => {
        const session = { ...withAgent('running'), createdBySessionId: 'creator' };
        expect(sessionAgentMenu(session, menuState(), none).creatorSessionId).toBeUndefined();
        expect(sessionAgentMenu(session, menuState(), new Set(['creator'])).creatorSessionId).toBe(
            'creator',
        );
    });
});
