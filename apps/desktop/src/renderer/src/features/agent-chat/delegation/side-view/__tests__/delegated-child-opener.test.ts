import type { SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { besideChatDelegationTerminalId, canOpenDelegatedChild } from '../delegated-child-opener';

const child = (relation: SessionRecord['createdByRelation']) =>
    ({
        id: 's-child',
        createdByRelation: relation,
        primaryAgentTerminalId: 't-agent',
    }) as SessionRecord;
const terminal = (id: string, surface?: 'chat') =>
    ({ id, sessionId: 's-child', ...(surface && { surface }) }) as TerminalRecord;

describe('besideChatDelegationTerminalId', () => {
    it('opens a consult beside the asking Chat through its Primary Agent Chat', () => {
        const terminals = [terminal('t-shell', 'chat'), terminal('t-agent', 'chat')];

        expect(besideChatDelegationTerminalId(child('consult'), terminals)).toBe('t-agent');
    });

    it('opens a Terminal consult as its own Session, since one PTY renders in one place', () => {
        expect(
            besideChatDelegationTerminalId(child('consult'), [terminal('t-agent')]),
        ).toBeUndefined();
    });

    it.each(['delegated', 'handoff', 'independent'] as const)(
        'opens a %s child as its own Session, where its sidebar row also leads',
        (relation) => {
            expect(
                besideChatDelegationTerminalId(child(relation), [terminal('t-agent', 'chat')]),
            ).toBeUndefined();
        },
    );

    it('opens nothing beside for a Session the Workbench no longer lists', () => {
        expect(besideChatDelegationTerminalId(undefined, [])).toBeUndefined();
    });
});

describe('canOpenDelegatedChild', () => {
    it('keeps a failed task that never launched a Terminal closed, since its Session has nothing to show', () => {
        expect(canOpenDelegatedChild({ hasTerminal: false, isFailed: true })).toBe(false);
    });

    it('opens a failed task that did launch, to read what went wrong', () => {
        expect(canOpenDelegatedChild({ hasTerminal: true, isFailed: true })).toBe(true);
    });

    it('opens a task still starting before its Terminal appears', () => {
        expect(canOpenDelegatedChild({ hasTerminal: false, isFailed: false })).toBe(true);
    });
});
