import type { GitSummary } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { GitSummaryTelemetry } from '../summary-telemetry';

function summary(overrides: Partial<GitSummary['repositories'][number]> = {}): GitSummary {
    return {
        isRepository: true,
        repositories: [
            {
                id: 'repo-a',
                kind: 'primary',
                name: 'fixture',
                rootPath: '/tmp/fixture',
                branch: 'main',
                head: 'a'.repeat(40),
                ahead: 0,
                behind: 0,
                additions: 1,
                deletions: 0,
                generation: 1,
                changedFileCount: 1,
                truncated: false,
                files: [{ path: 'src/a.txt', index: ' ', workingTree: 'M', kind: 'modified' }],
                ...overrides,
            },
        ],
    };
}

interface LoggedWrite {
    durationMs?: number;
    fields: Record<string, unknown>;
    level: string;
}

function createTelemetry(windowMs = 60_000) {
    let now = 1_000;
    const write = vi.fn<StructuredLogger['write']>();
    const telemetry = new GitSummaryTelemetry(
        { write } as unknown as StructuredLogger,
        windowMs,
        () => now,
    );
    const fields = {
        commandCount: 4,
        reason: 'request' as const,
        requester: 'renderer' as const,
        statusCoalesced: 0,
        statusFresh: 1,
        statusJoined: 0,
    };
    return {
        advance: (ms: number) => (now += ms),
        fields,
        telemetry,
        write,
        writesOf: (event: string, level?: string): LoggedWrite[] =>
            write.mock.calls
                .filter(
                    ([recordLevel, recordEvent]) =>
                        recordEvent === event && (level === undefined || recordLevel === level),
                )
                .map(([recordLevel, , options]) => ({
                    durationMs: options?.durationMs,
                    fields: options?.fields ?? {},
                    level: recordLevel,
                })),
    };
}

describe('GitSummaryTelemetry', () => {
    it('folds a steady background poll into one window record by default', () => {
        let now = 1_000;
        const write = vi.fn<StructuredLogger['write']>();
        const telemetry = new GitSummaryTelemetry(
            { write } as unknown as StructuredLogger,
            undefined,
            () => now,
        );
        const { fields } = createTelemetry();
        const unchanged = { ...fields, commandCount: 0 };
        for (let poll = 0; poll < 9; poll += 1) {
            telemetry.recordProduced('session-a', summary(), 2, unchanged);
            now += 75_000;
        }
        const windows = write.mock.calls.filter(([, event]) => event === 'git.refresh_summary');
        expect(windows.map((call) => call[2]?.fields?.refreshes)).toEqual([8]);
    });

    it('keeps a changed result at info and drops repeats to debug', () => {
        const { fields, telemetry, writesOf } = createTelemetry();
        telemetry.recordProduced('session-a', summary(), 10, fields);
        telemetry.recordProduced('session-a', summary({ generation: 2 }), 12, fields);
        telemetry.recordProduced('session-a', summary({ generation: 3 }), 8, fields);
        telemetry.recordProduced(
            'session-a',
            summary({ branch: 'feature', generation: 4 }),
            9,
            fields,
        );
        telemetry.recordProduced(
            'session-a',
            summary({ changedFileCount: 2, generation: 5 }),
            9,
            fields,
        );
        // Same counts, different dirty file: still a state transition the user can see.
        telemetry.recordProduced(
            'session-a',
            summary({
                changedFileCount: 2,
                generation: 6,
                files: [{ path: 'src/b.txt', index: ' ', workingTree: 'M', kind: 'modified' }],
            }),
            9,
            fields,
        );

        const info = writesOf('git.summary', 'info');
        expect(info).toHaveLength(4);
        expect(info.map((record) => record.fields.changed)).toEqual([true, true, true, true]);
        expect(writesOf('git.summary', 'debug').map((record) => record.fields.changed)).toEqual([
            false,
            false,
        ]);
        expect(JSON.stringify(info)).not.toContain('src/');
    });

    it('writes no per-call record for an unchanged production served entirely from cache', () => {
        const { fields, telemetry, writesOf } = createTelemetry();
        telemetry.recordProduced('session-a', summary(), 10, fields);
        telemetry.recordProduced('session-a', summary(), 1, { ...fields, commandCount: 0 });
        expect(writesOf('git.summary')).toHaveLength(1);
        telemetry.flush();
        expect(writesOf('git.refresh_summary')[0]?.fields).toMatchObject({ refreshes: 2 });
    });

    it('tracks fingerprints per Session so another Session does not suppress a first record', () => {
        const { fields, telemetry, writesOf } = createTelemetry();
        telemetry.recordProduced('session-a', summary(), 10, fields);
        telemetry.recordProduced('session-b', summary(), 10, fields);
        expect(writesOf('git.summary', 'info')).toHaveLength(2);
    });

    it('publishes one aggregate per elapsed window with volume, change count, and worst duration', () => {
        const { advance, fields, telemetry, writesOf } = createTelemetry(60_000);
        telemetry.recordProduced('session-a', summary(), 10, fields);
        telemetry.recordJoined('session-a', 'overview');
        advance(20_000);
        telemetry.recordQueued('session-a', 'extension', false);
        telemetry.recordProduced('session-a', summary({ generation: 2 }), 35, {
            ...fields,
            reason: 'refresh',
            requester: 'extension',
            commandCount: 6,
        });
        expect(writesOf('git.refresh_summary')).toHaveLength(0);

        advance(40_000);
        telemetry.recordProduced('session-a', summary({ generation: 3 }), 5, fields);
        const [aggregate] = writesOf('git.refresh_summary');
        // Spans the first to the last counted refresh, not to the refresh that closed the window.
        expect(aggregate).toMatchObject({
            level: 'info',
            durationMs: 20_000,
            fields: {
                sessionId: 'session-a',
                refreshes: 2,
                changed: 1,
                repeated: 1,
                joined: 1,
                queued: 1,
                commandCount: 10,
                statusFresh: 2,
                totalDurationMs: 45,
                maxDurationMs: 35,
                reasonRequest: 1,
                reasonRefresh: 1,
                requesterRenderer: 1,
                requesterExtension: 1,
            },
        });
        expect(aggregate.fields).not.toHaveProperty('requesterOverview');
        expect(aggregate.fields).toMatchObject({
            joinedOverview: 1,
            queuedExtension: 1,
            queuedShared: 0,
        });
        // Joined and queued reads spawned no Git command; only the aggregate counts them.
        expect(
            writesOf('git.summary', 'debug')
                .map((record) => record.fields.outcome)
                .filter((outcome) => outcome !== 'fresh'),
        ).toEqual([]);
        // The refresh that closed the old window belongs to the new one.
        advance(60_000);
        telemetry.recordProduced('session-a', summary({ generation: 4 }), 5, fields);
        expect(writesOf('git.refresh_summary')[1].fields).toMatchObject({ refreshes: 1 });
    });

    it('flushes open windows on eviction and restarts the fingerprint for a re-created Session', () => {
        const { fields, telemetry, writesOf } = createTelemetry();
        telemetry.recordProduced('session-a', summary(), 10, fields);
        telemetry.recordProduced('session-b', summary(), 10, fields);
        telemetry.flush(['session-a']);
        expect(writesOf('git.refresh_summary').map((record) => record.fields.sessionId)).toEqual([
            'session-a',
        ]);

        telemetry.recordProduced('session-a', summary(), 10, fields);
        expect(writesOf('git.summary', 'info')).toHaveLength(3);

        telemetry.flush();
        expect(writesOf('git.refresh_summary')).toHaveLength(3);
        telemetry.flush();
        expect(writesOf('git.refresh_summary')).toHaveLength(3);
    });

    it('reports a burst followed by idling as the burst, not as the idle time', () => {
        const { advance, fields, telemetry, writesOf } = createTelemetry(60_000);
        telemetry.recordProduced('session-a', summary(), 10, fields);
        advance(5_000);
        telemetry.recordProduced('session-a', summary({ generation: 2 }), 10, fields);
        advance(7_200_000);
        telemetry.flush();
        expect(writesOf('git.refresh_summary')[0]).toMatchObject({
            durationMs: 5_000,
            fields: { refreshes: 2 },
        });
    });
});
