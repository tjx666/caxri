import { describe, expect, it } from 'vitest';

import { StartupProfile } from '../startup-profile';

const frame = {
    kind: 'startup-frame' as const,
    diagnosticId: '00000000-0000-4000-8000-000000000000',
    documentVisible: true,
    firstFrameMs: 120,
    loaderRemovedMs: 100,
    timeOriginEpochMs: 1_000_500,
};

describe('StartupProfile', () => {
    it('rebases Renderer frame times onto the Main clock and reports every milestone once', () => {
        let now = 0;
        const profile = new StartupProfile(1_000_000, undefined, () => now);
        profile.mark('mainModule', 40.4);
        now = 90;
        profile.mark('appReady');
        now = 300;
        profile.mark('serverAttached');

        expect(profile.complete(frame)).toEqual({
            mainModuleMs: 40,
            appReadyMs: 90,
            serverAttachedMs: 300,
            windowCreatedMs: null,
            readyToShowMs: null,
            rendererReadyMs: null,
            loaderRemovedMs: 600,
            firstFrameMs: 620,
            documentVisible: true,
        });
    });

    it('keeps the first occurrence of a milestone and ignores later launches', () => {
        let now = 10;
        const profile = new StartupProfile(1_000_500, undefined, () => now);
        profile.mark('readyToShow');
        now = 900;
        profile.mark('readyToShow');

        expect(profile.complete(frame)?.readyToShowMs).toBe(10);
        // A Renderer reload reports another frame; the launch was already measured.
        expect(profile.complete(frame)).toBeUndefined();
    });
});
