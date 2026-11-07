import type { SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { besideChatDelegationTerminalId } from '../delegated-child-opener';

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
