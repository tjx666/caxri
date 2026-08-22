import { describe, expect, it } from 'vitest';

import { runtimeEventPayloads, runtimeEventSchema } from '../events';

describe('runtimeEventSchema', () => {
    it('rejects an unknown event name', () => {
        expect(
            runtimeEventSchema.safeParse({
                event: 'not.a.real.event',
                payload: {},
            }).success,
        ).toBe(false);
    });

    it('rejects a known event name paired with another event payload', () => {
        expect(
            runtimeEventSchema.safeParse({
                event: 'terminal.exit',
                payload: { terminalId: 'terminal-1', data: 'not part of terminal.exit' },
            }).success,
        ).toBe(false);
    });

    it('accepts every declared event with a minimal valid payload', () => {
        expect(
            runtimeEventSchema.safeParse({
                event: 'terminal.exit',
                payload: { terminalId: 'terminal-1', exitCode: 0 },
            }).success,
        ).toBe(true);
        expect(
            runtimeEventSchema.safeParse({
                event: 'window.fullScreen',
                payload: { isFullScreen: true },
            }).success,
        ).toBe(true);
        expect(
            runtimeEventSchema.safeParse({
                event: 'command.execute',
                payload: { command: 'session.selectNext' },
            }).success,
        ).toBe(true);
        expect(
            runtimeEventSchema.safeParse({
                event: 'desktop.openRequested',
                payload: {
                    sessionId: 'session-1',
                    kind: 'file',
                    location: { line: 12, column: 4 },
                },
            }).success,
        ).toBe(true);
    });
});

describe('runtime.status payload', () => {
    it('excludes the transient starting status from the wire event', () => {
        expect(
            runtimeEventPayloads['runtime.status'].safeParse({
                status: 'starting',
                restartCount: 0,
            }).success,
        ).toBe(false);
        expect(
            runtimeEventPayloads['runtime.status'].safeParse({
                status: 'ready',
                restartCount: 0,
            }).success,
        ).toBe(true);
    });
});

describe('workbench.changed payload', () => {
    it('only accepts a bounded reason enum', () => {
        expect(
            runtimeEventPayloads['workbench.changed'].safeParse({
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
                reason: 'selected',
            }).success,
        ).toBe(true);
        expect(
            runtimeEventPayloads['workbench.changed'].safeParse({
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
                reason: 'unsupported-reason',
            }).success,
        ).toBe(false);
    });
});

describe('state.changed normalization', () => {
    const schema = runtimeEventPayloads['state.changed'];

    it('passes through a well-formed full-state payload', () => {
        expect(schema.parse({ kind: 'full', reason: 'session.create' })).toEqual({
            kind: 'full',
            reason: 'session.create',
        });
    });

    it('passes through a well-formed records payload with default record arrays', () => {
        expect(schema.parse({ kind: 'records', sessionIds: ['session-1'] })).toEqual({
            kind: 'records',
            sessionIds: ['session-1'],
            terminalIds: [],
        });
    });

    it('converges an unrecognized future scope to a full unknown-reason payload', () => {
        expect(schema.parse({ kind: 'future-scope', anything: true })).toEqual({
            kind: 'full',
            reason: 'unknown',
        });
        expect(schema.parse(null)).toEqual({ kind: 'full', reason: 'unknown' });
        expect(schema.parse('not-an-object')).toEqual({ kind: 'full', reason: 'unknown' });
        expect(schema.parse(undefined)).toEqual({ kind: 'full', reason: 'unknown' });
    });

    it('still rejects a recognized kind with an invalid reason', () => {
        expect(schema.safeParse({ kind: 'full', reason: 'not-a-real-reason' }).success).toBe(false);
    });
});
