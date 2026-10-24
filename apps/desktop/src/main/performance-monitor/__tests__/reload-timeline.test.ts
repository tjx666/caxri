import { describe, expect, it } from 'vitest';

import { ReloadTimeline } from '../reload-timeline';

function setup() {
    let now = 1_000;
    const timeline = new ReloadTimeline(() => now);
    return {
        advance: (ms: number) => {
            now += ms;
        },
        timeline,
    };
}

describe('ReloadTimeline', () => {
    it('records stages relative to the navigation start and closes on the startup frame', () => {
        const { advance, timeline } = setup();
        timeline.begin();
        advance(120);
        timeline.mark('domReady');
        advance(80);
        timeline.mark('didFinishLoad');
        timeline.recordStartupFrame({
            firstFrameMs: 400,
            loaderRemovedMs: 350,
            timeOriginEpochMs: 1_000,
        });
        const [entry] = timeline.list();
        expect(entry).toMatchObject({
            kind: 'reload',
            outcome: 'done',
            stages: { domReady: 120, didFinishLoad: 200, loaderRemoved: 350, firstFrame: 400 },
        });
    });

    it('uses the announced kind once and defaults to reload', () => {
        const { timeline } = setup();
        timeline.announce('hard-reload');
        timeline.begin();
        timeline.mark('didFinishLoad');
        timeline.begin();
        expect(timeline.list().map((entry) => entry.kind)).toEqual(['reload', 'hard-reload']);
    });

    it('drops an aborted load, keeps a finished one, and caps history at ten', () => {
        const { timeline } = setup();
        timeline.begin();
        timeline.begin();
        expect(timeline.list()).toHaveLength(1);
        timeline.mark('didFinishLoad');
        timeline.begin();
        expect(timeline.list()[1]?.outcome).toBe('done');
        for (let index = 0; index < 15; index += 1) {
            timeline.mark('didFinishLoad');
            timeline.begin();
        }
        expect(timeline.list()).toHaveLength(10);
    });

    it('ignores a startup frame from before the load and records failures', () => {
        const { advance, timeline } = setup();
        advance(5_000);
        timeline.begin();
        timeline.recordStartupFrame({
            firstFrameMs: 10,
            loaderRemovedMs: 5,
            timeOriginEpochMs: 100,
        });
        expect(timeline.list()[0]?.outcome).toBe('loading');
        timeline.fail('render-process-gone');
        expect(timeline.list()[0]).toMatchObject({
            failure: 'render-process-gone',
            outcome: 'failed',
        });
    });
});
