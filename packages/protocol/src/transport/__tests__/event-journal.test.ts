import { describe, expect, it } from 'vitest';

import { CaxriError } from '../errors';
import {
    createEventJournal,
    durableRuntimeEventSchema,
    isTransientRuntimeEvent,
    MAX_EVENT_JOURNAL_EVENTS,
    transientRuntimeEventSchema,
} from '../event-journal';

describe('isTransientRuntimeEvent / transient and durable schemas', () => {
    it('classifies direct-delivery events (PTY bytes, one-shot commands) as transient', () => {
        expect(isTransientRuntimeEvent({ event: 'terminal.output', payload: {} } as never)).toBe(
            true,
        );
        expect(
            isTransientRuntimeEvent({ event: 'terminal.outputRecovery', payload: {} } as never),
        ).toBe(true);
        expect(isTransientRuntimeEvent({ event: 'command.execute', payload: {} } as never)).toBe(
            true,
        );
        expect(
            isTransientRuntimeEvent({ event: 'host.connectionChanged', payload: {} } as never),
        ).toBe(true);
        expect(
            isTransientRuntimeEvent({ event: 'projectStatus.changed', payload: {} } as never),
        ).toBe(true);
        expect(
            isTransientRuntimeEvent({
                event: 'viewContainers.catalogChanged',
                payload: {},
            } as never),
        ).toBe(true);
    });

    it('classifies a durable state event as non-transient', () => {
        expect(
            isTransientRuntimeEvent({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            } as never),
        ).toBe(false);
    });

    it('accepts only transient events through transientRuntimeEventSchema', () => {
        expect(
            transientRuntimeEventSchema.safeParse({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'hi' },
            }).success,
        ).toBe(true);
        expect(
            transientRuntimeEventSchema.safeParse({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            }).success,
        ).toBe(false);
    });

    it('rejects a transient event through durableRuntimeEventSchema', () => {
        expect(
            durableRuntimeEventSchema.safeParse({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'hi' },
            }).success,
        ).toBe(false);
        expect(
            durableRuntimeEventSchema.safeParse({
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
