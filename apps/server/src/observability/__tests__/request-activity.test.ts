import { describe, expect, it } from 'vitest';

import { RequestActivityTracker } from '../request-activity';

function createTracker() {
    let nowMs = 0;
    const tracker = new RequestActivityTracker(() => nowMs);
    return {
        tracker,
        advance: (ms: number) => {
            nowMs += ms;
        },
    };
}

describe('request activity tracker', () => {
    it('names running requests with elapsed time, longest first', () => {
        const { tracker, advance } = createTracker();
        tracker.begin('a', 'git.sync');
        advance(300);
        tracker.begin('b', 'session.select');
        advance(40);

        expect(tracker.summarize(1000)).toEqual({
            finished: '',
            inFlight: 'git.sync=340,session.select=40',
            inFlightCount: 2,
        });
        expect(tracker.methodOf('a')).toBe('git.sync');
    });

    it('keeps a request that already returned when the stall is reported', () => {
        const { tracker, advance } = createTracker();
        const end = tracker.begin('a', 'files.copy');
        advance(800);
        end();
        advance(10);

        expect(tracker.summarize(900)).toEqual({
            finished: 'files.copy=800',
            inFlight: '',
            inFlightCount: 0,
        });
        expect(tracker.methodOf('a')).toBeUndefined();
    });

    it('drops finished requests older than the window', () => {
        const { tracker, advance } = createTracker();
        tracker.begin('a', 'files.copy')();
        advance(5000);

        expect(tracker.summarize(1000).finished).toBe('');
    });

    it('ignores a second end call and reports at most five methods', () => {
        const { tracker, advance } = createTracker();
        for (let index = 0; index < 8; index += 1) {
            advance(1);
            tracker.begin(`id-${index}`, `m${index}`);
        }
        const end = tracker.begin('x', 'dup');
        end();
        end();

        const summary = tracker.summarize(1000);
        expect(summary.inFlight.split(',')).toHaveLength(5);
        expect(summary.finished.split(',')).toHaveLength(1);
    });

    it('keeps a request running when a nested operation sharing its id finishes first', () => {
        const { tracker } = createTracker();
        tracker.begin('control-1', 'session.select');
        const endNested = tracker.begin('control-1', 'git.status');
        endNested();

        expect(tracker.methodOf('control-1')).toBe('session.select');
        expect(tracker.summarize(1000).inFlightCount).toBe(1);
    });

    it('still names the caller of background work that outlives the request', async () => {
        const { tracker } = createTracker();
        let background: Promise<string | undefined> = Promise.resolve(undefined);

        tracker.runAs('control-2', 'git.summary', () => {
            const end = tracker.begin('control-2', 'git.summary');
            // A refresh the handler starts and does not await, like the Git command behind a returned summary.
            background = new Promise((resolve) =>
                setTimeout(() => resolve(tracker.methodOf('control-2')), 0),
            );
            end();
        });

        await expect(background).resolves.toBe('git.summary');
        expect(tracker.methodOf('control-2')).toBeUndefined();
        expect(tracker.runAs('other', 'x', () => tracker.methodOf('control-2'))).toBeUndefined();
    });
});
