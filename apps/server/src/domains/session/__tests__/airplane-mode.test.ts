import type { AirplaneModeState, SessionCompactionResult } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { AirplaneModeOptions } from '../airplane-mode';
import { AirplaneMode, isAirplaneModeHolding } from '../airplane-mode';

interface Harness {
    airplane: AirplaneMode;
    stored: () => unknown;
    compacting: Set<string>;
    detached: string[];
    resumed: string[];
    published: AirplaneModeState[];
    reasons: () => unknown[];
    finishCompaction: (result: SessionCompactionResult) => void;
}

function createHarness(
    overrides: Partial<AirplaneModeOptions> & { stored?: unknown; live?: string[] } = {},
): Harness {
    let stored: unknown = overrides.stored;
    const sessions = ['s1', 's2', 's3'].map((id) => ({ id, primaryAgentTerminalId: `t-${id}` }));
    const live = new Set(overrides.live ?? ['s1', 's2']);
    const compacting = new Set<string>();
    const detached: string[] = [];
    const resumed: string[] = [];
    const published: AirplaneModeState[] = [];
    const write = vi.fn<StructuredLogger['write']>();
    let finishCompaction: (result: SessionCompactionResult) => void = () => {};
    const database = {
        getAppState: () => stored,
        setAppState: (_key: string, value: unknown) => {
            stored = value;
        },
        getSession: (id: string) => sessions.find((session) => session.id === id),
        listSessions: () => sessions,
    } as unknown as AirplaneModeOptions['database'];
    const airplane = new AirplaneMode({
        database,
        compact: () => {
            const compaction = Promise.withResolvers<SessionCompactionResult>();
            finishCompaction = compaction.resolve;
            return compaction.promise;
        },
        isCompacting: (terminalId) => compacting.has(terminalId),
        hasLiveAgent: (sessionId) => live.has(sessionId),
        detach: (sessionId) => {
            detached.push(sessionId);
            live.delete(sessionId);
            return Promise.resolve();
        },
        resume: (sessionId) => {
            resumed.push(sessionId);
            return Promise.resolve();
        },
        publish: (state) => published.push(state),
        logger: { write } as unknown as StructuredLogger,
        pollMs: 5,
        ...overrides,
    });
    return {
        airplane,
        stored: () => stored,
        compacting,
        detached,
        resumed,
        published,
        reasons: () =>
            write.mock.calls.map(
                (call) => (call[2] as { fields: { reason: unknown } }).fields.reason,
            ),
        finishCompaction: (result) => finishCompaction(result),
    };
}

const submittedS1: SessionCompactionResult = {
    items: [
        { sessionId: 's1', outcome: 'submitted' },
        { sessionId: 's2', outcome: 'not_warm' },
    ],
} as SessionCompactionResult;

describe('AirplaneMode', () => {
    it('waits for the submitted compactions, then detaches every live Agent', async () => {
        const harness = createHarness();
        harness.compacting.add('t-s1');
        expect(harness.airplane.enter().phase).toBe('compacting');
        expect(harness.airplane.holds()).toBe(false);
        harness.finishCompaction(submittedS1);
        await vi.waitFor(() =>
            expect(harness.airplane.status().compaction).toMatchObject({
                pending: 1,
                submitted: 1,
            }),
        );
        expect(harness.detached).toEqual([]);
        harness.compacting.delete('t-s1');
        await vi.waitFor(() => expect(harness.airplane.status().phase).toBe('on'));
        expect(harness.detached.toSorted((a, b) => a.localeCompare(b))).toEqual(['s1', 's2']);
        expect(
            harness.airplane.status().parkedSessionIds.toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(['s1', 's2']);
        expect(harness.airplane.holds()).toBe(true);
        expect(harness.stored()).toMatchObject({ phase: 'on' });
        expect(harness.reasons()).toEqual(['entered', 'compactionFinished', 'parked']);
    });

    it('parks at once when the user skips the compaction wait', async () => {
        const harness = createHarness();
        harness.airplane.enter();
        harness.airplane.skipCompaction();
        await vi.waitFor(() => expect(harness.airplane.status().phase).toBe('on'));
        expect(harness.reasons()).toContain('compactionSkipped');
    });

    it('parks anyway once the compaction wait times out', async () => {
        const harness = createHarness({ compactionWaitMs: 20 });
        harness.compacting.add('t-s1');
        harness.airplane.enter();
        harness.finishCompaction(submittedS1);
        await vi.waitFor(() => expect(harness.airplane.status().phase).toBe('on'));
        expect(harness.reasons()).toContain('compactionTimedOut');
    });

    it('parks when the compaction itself fails', async () => {
        const harness = createHarness({ compact: () => Promise.reject(new Error('boom')) });
        harness.airplane.enter();
        await vi.waitFor(() => expect(harness.airplane.status().phase).toBe('on'));
        expect(harness.reasons()).toContain('compactionFailed');
    });

    it('cancelling during the compaction wait stops nothing, and a later entry is not parked by the old wait', async () => {
        const harness = createHarness();
        harness.compacting.add('t-s1');
        harness.airplane.enter();
        expect(harness.airplane.exit([]).phase).toBe('off');
        harness.finishCompaction(submittedS1);
        harness.airplane.enter();
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(harness.detached).toEqual([]);
        expect(harness.airplane.status().phase).toBe('compacting');
    });

    it('resumes only the picked parked Sessions, then turns off', async () => {
        const harness = createHarness();
        harness.airplane.enter();
        harness.airplane.skipCompaction();
        await vi.waitFor(() => expect(harness.airplane.status().phase).toBe('on'));
        expect(harness.airplane.exit(['s2', 's3']).phase).toBe('resuming');
        expect(harness.airplane.holds()).toBe(false);
        await vi.waitFor(() => expect(harness.airplane.status().phase).toBe('off'));
        // s3 was never parked, so it is not relaunched.
        expect(harness.resumed).toEqual(['s2']);
        expect(harness.stored()).toMatchObject({ phase: 'off', parkedSessionIds: [] });
    });

    it('adds a Session whose launch the fence parked to the resumable list', async () => {
        const harness = createHarness({ live: [] });
        harness.airplane.noteParked('s3');
        expect(harness.airplane.status().parkedSessionIds).toEqual([]);
        harness.airplane.enter();
        harness.airplane.skipCompaction();
        await vi.waitFor(() => expect(harness.airplane.status().phase).toBe('on'));
        harness.airplane.noteParked('s3');
        harness.airplane.noteParked('s3');
        expect(harness.airplane.status().parkedSessionIds).toEqual(['s3']);
    });

    it('finishes an entry a previous Server Core left unfinished, and ends an interrupted resume', async () => {
        const entering = createHarness({ stored: { phase: 'compacting', parkedSessionIds: [] } });
        entering.airplane.start();
        await vi.waitFor(() => expect(entering.airplane.status().phase).toBe('on'));
        expect(entering.reasons()).toEqual(['serverRestarted', 'parked']);

        const resuming = createHarness({ stored: { phase: 'resuming', parkedSessionIds: ['s1'] } });
        resuming.airplane.start();
        expect(resuming.airplane.status()).toEqual({ phase: 'off', parkedSessionIds: [] });
        expect(resuming.resumed).toEqual([]);
    });

    it('holds Agent launches only while parking or on', () => {
        expect(isAirplaneModeHolding(undefined)).toBe(false);
        expect(isAirplaneModeHolding({ phase: 'compacting' })).toBe(false);
        expect(isAirplaneModeHolding({ phase: 'parking' })).toBe(true);
        expect(isAirplaneModeHolding({ phase: 'on' })).toBe(true);
        expect(isAirplaneModeHolding({ phase: 'resuming' })).toBe(false);
    });
});
