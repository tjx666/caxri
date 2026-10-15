import { describe, expect, it } from 'vitest';

import { parseAndroidDisplayState } from '../mobile-android-display-state';

describe('Android display state', () => {
    it('normalizes physical and override display state for exact restoration', () => {
        expect(
            parseAndroidDisplayState({
                density: 'Physical density: 420\nOverride density: 320',
                fontScale: '1.0',
                rotation: 'SurfaceOrientation: 1',
                size: 'Physical size: 1080x2400\nOverride size: 1600x2560',
            }),
        ).toEqual({
            density: { override: 320, physical: 420 },
            fontScale: 1,
            rotation: 1,
            size: {
                override: { height: 2560, width: 1600 },
                physical: { height: 2400, width: 1080 },
            },
        });
    });

    it('reads rotation from the active Android 36 internal viewport', () => {
        expect(
            parseAndroidDisplayState({
                density: 'Physical density: 420',
                fontScale: '1.0',
                rotation:
                    'Viewport INTERNAL: displayId=0, orientation=1, logicalFrame=[0, 0, 2400, 1080], isActive=[1]',
                size: 'Physical size: 1080x2400',
            }).rotation,
        ).toBe(1);
    });
});
