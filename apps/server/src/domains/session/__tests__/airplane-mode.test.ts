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
    continued: string[];
    continuedLive: string[];
    interrupted: string[];
    running: Set<string>;
    published: AirplaneModeState[];
    reasons: () => unknown[];
    /**
     * Resolves the batch compaction once entering requested it, after the interrupt step.
     */
    finishCompaction: (result: SessionCompactionResult) => Promise<void>;
    compactionRequested: () => Promise<void>;
}

function createHarness(
    overrides: Partial<AirplaneModeOptions> & {
        stored?: unknown;
        live?: string[];
        working?: string[];
    } = {},
): Harness {
    let stored: unknown = overrides.stored;
    const sessions = ['s1', 's2', 's3'].map((id) => ({ id, primaryAgentTerminalId: `t-${id}` }));
    const live = new Set(overrides.live ?? ['s1', 's2']);
    const compacting = new Set<string>();
    const detached: string[] = [];
    const resumed: string[] = [];
    const continued: string[] = [];
    const continuedLive: string[] = [];
    const interrupted: string[] = [];
    const working = new Set(overrides.working);
    const running = new Set(working);
    const published: AirplaneModeState[] = [];
    const write = vi.fn<StructuredLogger['write']>();
    let finishCompaction: ((result: SessionCompactionResult) => void) | undefined;
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
        isWorking: (sessionId) => working.has(sessionId),
        interrupt: (sessionId) => {
            interrupted.push(sessionId);
            return Promise.resolve(true);
        },
        isTurnRunning: (sessionId) => running.has(sessionId),
        detach: (sessionId) => {
            detached.push(sessionId);
            live.delete(sessionId);
            return Promise.resolve();
        },
        resume: (sessionId, shouldContinue) => {
            resumed.push(sessionId);
            if (shouldContinue) continued.push(sessionId);
            return Promise.resolve();
        },
        continueLive: (sessionId) => {
            continuedLive.push(sessionId);
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
        continued,
        continuedLive,
        interrupted,
        running,
        published,
        reasons: () =>
            write.mock.calls.map(
                (call) => (call[2] as { fields: { reason: unknown } }).fields.reason,
            ),
        compactionRequested: () =>
            vi.waitFor(() => {
                expect(finishCompaction).toBeDefined();
            }),
        finishCompaction: async (result) => {
            await vi.waitFor(() => expect(finishCompaction).toBeDefined());
            finishCompaction!(result);
        },
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
        await harness.finishCompaction(submittedS1);
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
        await harness.finishCompaction(submittedS1);
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
        await harness.compactionRequested();
        expect(harness.airplane.exit([]).phase).toBe('off');
        await harness.finishCompaction(submittedS1);
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
        const entering = createHarness({
            stored: { phase: 'compacting', parkedSessionIds: [], continueSessionIds: [] },
        });
        entering.airplane.start();
        await vi.waitFor(() => expect(entering.airplane.status().phase).toBe('on'));
        expect(entering.reasons()).toEqual(['serverRestarted', 'parked']);

        const resuming = createHarness({
            stored: { phase: 'resuming', parkedSessionIds: ['s1'], continueSessionIds: [] },
        });
        resuming.airplane.start();
        expect(resuming.airplane.status()).toEqual({
            phase: 'off',
            parkedSessionIds: [],
            continueSessionIds: [],
        });
        expect(resuming.resumed).toEqual([]);
    });

    it('interrupts the working Sessions, compacts once their turns settled, and continues only them on resume', async () => {
        const compact = vi.fn(() =>
            Promise.resolve({ items: [], deferred: 0 } as SessionCompactionResult),
        );
        const harness = createHarness({ live: ['s1', 's2'], working: ['s1', 's3'], compact });
        harness.airplane.enter();
        // s3 has no live Agent, so it is neither interrupted nor continued.
        expect(harness.airplane.status().continueSessionIds).toEqual(['s1']);
        expect(harness.stored()).toMatchObject({ continueSessionIds: ['s1'] });
        await vi.waitFor(() => expect(harness.interrupted).toEqual(['s1']));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(compact).not.toHaveBeenCalled();
        harness.running.delete('s1');
        await vi.waitFor(() => expect(harness.airplane.status().phase).toBe('on'));
        expect(compact).toHaveBeenCalledOnce();
        harness.airplane.exit(['s1', 's2']);
        await vi.waitFor(() => expect(harness.airplane.status().phase).toBe('off'));
        expect(harness.resumed).toEqual(['s1', 's2']);
        expect(harness.continued).toEqual(['s1']);
        expect(harness.airplane.status().continueSessionIds).toEqual([]);
    });

    it('compacts anyway once an interrupted turn outlives the wait, and skipping during it parks at once', async () => {
        const compact = vi.fn(() =>
            Promise.resolve({ items: [], deferred: 0 } as SessionCompactionResult),
        );
        const late = createHarness({ working: ['s1'], compact, interruptWaitMs: 20 });
        late.airplane.enter();
        await vi.waitFor(() => expect(late.airplane.status().phase).toBe('on'));
        expect(compact).toHaveBeenCalledOnce();

        const skipping = createHarness({ working: ['s1'], compact: vi.fn() });
        skipping.airplane.enter();
        await vi.waitFor(() => expect(skipping.interrupted).toEqual(['s1']));
        skipping.airplane.skipCompaction();
        await vi.waitFor(() => expect(skipping.airplane.status().phase).toBe('on'));
        expect(skipping.reasons()).toContain('compactionSkipped');
    });

    it('cancelling after interrupting tells those still-running Agents to continue', async () => {
        const harness = createHarness({ working: ['s1'] });
        harness.airplane.enter();
        await vi.waitFor(() => expect(harness.interrupted).toEqual(['s1']));
        expect(harness.airplane.exit([]).phase).toBe('off');
        await vi.waitFor(() => expect(harness.continuedLive).toEqual(['s1']));
        expect(harness.detached).toEqual([]);
    });

    it('holds Agent launches only while parking or on', () => {
        expect(isAirplaneModeHolding(undefined)).toBe(false);
        expect(isAirplaneModeHolding({ phase: 'compacting' })).toBe(false);
        expect(isAirplaneModeHolding({ phase: 'parking' })).toBe(true);
        expect(isAirplaneModeHolding({ phase: 'on' })).toBe(true);
        expect(isAirplaneModeHolding({ phase: 'resuming' })).toBe(false);
    });
});
