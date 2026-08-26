import { describe, expect, it } from 'vitest';

import { CaxriError } from '../errors';
import {
    createEventJournal,
    durableServerEventSchema,
    isTransientServerEvent,
    MAX_EVENT_JOURNAL_EVENTS,
    transientServerEventSchema,
} from '../event-journal';

describe('isTransientServerEvent / transient and durable schemas', () => {
    it('classifies direct-delivery events (PTY bytes, one-shot commands) as transient', () => {
        expect(isTransientServerEvent({ event: 'terminal.output', payload: {} } as never)).toBe(
            true,
        );
        expect(
            isTransientServerEvent({ event: 'terminal.outputRecovery', payload: {} } as never),
        ).toBe(true);
        expect(isTransientServerEvent({ event: 'command.execute', payload: {} } as never)).toBe(
            true,
        );
        expect(
            isTransientServerEvent({ event: 'host.connectionChanged', payload: {} } as never),
        ).toBe(true);
        expect(
            isTransientServerEvent({ event: 'projectStatus.changed', payload: {} } as never),
        ).toBe(true);
        expect(
            isTransientServerEvent({
                event: 'viewContainers.catalogChanged',
                payload: {},
            } as never),
        ).toBe(true);
    });

    it('classifies a durable state event as non-transient', () => {
        expect(
            isTransientServerEvent({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            } as never),
        ).toBe(false);
    });

    it('accepts only transient events through transientServerEventSchema', () => {
        expect(
            transientServerEventSchema.safeParse({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'hi' },
            }).success,
        ).toBe(true);
        expect(
            transientServerEventSchema.safeParse({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            }).success,
        ).toBe(false);
    });

    it('rejects a transient event through durableServerEventSchema', () => {
        expect(
            durableServerEventSchema.safeParse({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'hi' },
            }).success,
        ).toBe(false);
        expect(
            durableServerEventSchema.safeParse({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            }).success,
        ).toBe(true);
    });
});

describe('createEventJournal capacity validation', () => {
    const snapshot = (cursor: number) => ({
        cursor,
        projectIds: [],
        sessionIds: [],
        terminalIds: [],
        settingsRevision: cursor,
        diagnosticsRevision: cursor,
        agentRevision: cursor,
    });

    it('rejects a capacity outside the 1..MAX_EVENT_JOURNAL_EVENTS bound', () => {
        expect(() => createEventJournal({ snapshot, maximumEvents: 0 })).toThrow(CaxriError);
        expect(() =>
            createEventJournal({ snapshot, maximumEvents: MAX_EVENT_JOURNAL_EVENTS + 1 }),
        ).toThrow(CaxriError);
        expect(() => createEventJournal({ snapshot, maximumEvents: 1.5 })).toThrow(CaxriError);
    });

    it('accepts the bound edges', () => {
        expect(() => createEventJournal({ snapshot, maximumEvents: 1 })).not.toThrow();
        expect(() =>
            createEventJournal({ snapshot, maximumEvents: MAX_EVENT_JOURNAL_EVENTS }),
        ).not.toThrow();
    });
});

describe('createEventJournal.recover cursor validation', () => {
    it('rejects a recovery cursor ahead of the journal', async () => {
        const journal = createEventJournal({
            maximumEvents: 2,
            snapshot: (cursor) => ({
                cursor,
                projectIds: [],
                sessionIds: [],
                terminalIds: [],
                settingsRevision: cursor,
                diagnosticsRevision: cursor,
                agentRevision: cursor,
            }),
        });
        await expect(journal.recover(10)).rejects.toThrow(CaxriError);
    });
});
