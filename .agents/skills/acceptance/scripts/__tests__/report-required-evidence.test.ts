import { describe, expect, it } from 'vitest';

import { assertRequiredEvidence } from '../report-required-evidence';

const screenshot = { source: 'android-framebuffer', type: 'screenshot' };

describe('assertRequiredEvidence', () => {
    it('accepts cited evidence of the required medium and source', () => {
        expect(() =>
            assertRequiredEvidence(
                'MOB-1',
                [screenshot, { type: 'text' }],
                [
                    { path: 'assets/MOB-1-android.png', ...screenshot },
                    { path: 'assets/MOB-1-scenario.txt', type: 'text' },
                ],
            ),
        ).not.toThrow();
    });

    it('names the entry and field when a cited screenshot omits its source', () => {
        expect(() =>
            assertRequiredEvidence(
                'MOB-1',
                [screenshot],
                [{ path: 'assets/MOB-1-android.png', type: 'screenshot' }],
            ),
        ).toThrow(
            'Case MOB-1 is missing required evidence: screenshot:android-framebuffer (the evidence entry for assets/MOB-1-android.png has no "source"; set "source": "android-framebuffer" on it)',
        );
    });

    it('names a conflicting source, and keeps the bare message when no such medium is cited', () => {
        expect(() =>
            assertRequiredEvidence(
                'MOB-1',
                [screenshot],
                [
                    {
                        path: 'assets/MOB-1-android.png',
                        source: 'isolated-desktop-renderer',
                        type: 'screenshot',
                    },
                ],
            ),
        ).toThrow('declares "source": "isolated-desktop-renderer"');
        expect(() => assertRequiredEvidence('MOB-1', [screenshot, { type: 'video' }], [])).toThrow(
            /missing required evidence: screenshot:android-framebuffer, video$/,
        );
    });
});
