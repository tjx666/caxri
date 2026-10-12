import { describe, expect, it } from 'vitest';

import { serverEventPayloads, serverEventSchema } from '../events';

describe('serverEventSchema', () => {
    it('rejects an unknown event name', () => {
        expect(
            serverEventSchema.safeParse({
                event: 'not.a.real.event',
                payload: {},
            }).success,
        ).toBe(false);
    });

    it('rejects a known event name paired with another event payload', () => {
        expect(
            serverEventSchema.safeParse({
                event: 'terminal.exit',
                payload: { terminalId: 'terminal-1', data: 'not part of terminal.exit' },
            }).success,
        ).toBe(false);
    });

    it('accepts every declared event with a minimal valid payload', () => {
        expect(
            serverEventSchema.safeParse({
                event: 'terminal.exit',
                payload: { terminalId: 'terminal-1', exitCode: 0 },
            }).success,
        ).toBe(true);
        expect(
            serverEventSchema.safeParse({
                event: 'viewContainers.viewChanged',
                payload: {
                    viewId: 'publisher.fixture.files',
                    eventId: 'view-event-1',
                    extensionGeneration: 2,
                    context: {
                        kind: 'session',
                        sessionId: 'session-1',
                        workbenchProjectId: 'project-1',
                    },
                    change: { kind: 'refresh' },
                },
            }).success,
        ).toBe(true);
        expect(
            serverEventSchema.safeParse({
                event: 'viewContainers.treeChanged',
                payload: {
                    viewId: 'publisher.fixture.status',
                    eventId: 'view-event-2',
                    extensionGeneration: 2,
                    context: { kind: 'no-session' },
                },
            }).success,
        ).toBe(true);
        expect(
            serverEventSchema.safeParse({
                event: 'window.fullScreen',
                payload: { window: 'workbench', isFullScreen: true },
            }).success,
        ).toBe(true);
        expect(
            serverEventSchema.safeParse({
                event: 'command.execute',
                payload: { command: 'session.selectNext' },
            }).success,
        ).toBe(true);
        expect(
            serverEventSchema.safeParse({
                event: 'desktop.openRequested',
                payload: {
                    sessionId: 'session-1',
                    kind: 'file',
                    location: { mode: 'line', startLine: 12, endLine: 14 },
                },
            }).success,
        ).toBe(true);
        expect(
            serverEventSchema.safeParse({
                event: 'gpu.recoveryRequested',
                payload: { correlationId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae' },
            }).success,
        ).toBe(true);
    });
});

describe('runtime.status payload', () => {
    it('excludes the transient starting status from the wire event', () => {
        expect(
            serverEventPayloads['runtime.status'].safeParse({
                status: 'starting',
                restartCount: 0,
            }).success,
        ).toBe(false);
        expect(
            serverEventPayloads['runtime.status'].safeParse({
                status: 'ready',
                restartCount: 0,
            }).success,
        ).toBe(true);
    });
});

describe('workbench.changed payload', () => {
    it('only accepts a bounded reason enum', () => {
        expect(
            serverEventPayloads['workbench.changed'].safeParse({
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
                reason: 'selected',
            }).success,
        ).toBe(true);
        expect(
            serverEventPayloads['workbench.changed'].safeParse({
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
                reason: 'unsupported-reason',
            }).success,
        ).toBe(false);
    });

    it('carries the destination title of an Agent-driven switch', () => {
        expect(
            serverEventPayloads['workbench.changed'].safeParse({
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
                reason: 'followed',
                followedProjectTitle: 'feature-entered',
            }),
        ).toMatchObject({
            success: true,
            data: { reason: 'followed', followedProjectTitle: 'feature-entered' },
        });
        expect(
            serverEventPayloads['workbench.changed'].safeParse({
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
                reason: 'followed',
                followedProjectTitle: '',
            }).success,
        ).toBe(false);
    });
});

describe('state.changed normalization', () => {
    const schema = serverEventPayloads['state.changed'];

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
