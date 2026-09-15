import { describe, expect, it } from 'vitest';

import { resolveChromeFocusHandoff } from './chrome-focus-handoff';

describe('resolveChromeFocusHandoff', () => {
    describe('revealing the surface', () => {
        it('hands focus to the surface and remembers where focus came from', () => {
            expect(
                resolveChromeFocusHandoff({
                    focusLocation: 'outside-surface',
                    isOriginRestorable: false,
                    isRevealing: true,
                }),
            ).toEqual({ recordsOrigin: true, target: 'surface' });
        });

        it('records nothing when no element owned focus', () => {
            expect(
                resolveChromeFocusHandoff({
                    focusLocation: 'nowhere',
                    isOriginRestorable: false,
                    isRevealing: true,
                }),
            ).toEqual({ recordsOrigin: false, target: 'surface' });
        });

        it('replaces a stale origin left behind by an earlier reveal', () => {
            expect(
                resolveChromeFocusHandoff({
                    focusLocation: 'outside-surface',
                    isOriginRestorable: true,
                    isRevealing: true,
                }),
            ).toEqual({ recordsOrigin: true, target: 'surface' });
        });
    });

    describe('hiding the surface', () => {
        it('returns focus to the element that owned it before the reveal', () => {
            expect(
                resolveChromeFocusHandoff({
                    focusLocation: 'inside-surface',
                    isOriginRestorable: true,
                    isRevealing: false,
                }),
            ).toEqual({ recordsOrigin: false, target: 'origin' });
        });

        it('falls back when the recorded origin can no longer take focus', () => {
            expect(
                resolveChromeFocusHandoff({
                    focusLocation: 'inside-surface',
                    isOriginRestorable: false,
                    isRevealing: false,
                }),
            ).toEqual({ recordsOrigin: false, target: 'fallback' });
        });

        it('claims focus that the unmounting surface would otherwise drop on the document', () => {
            expect(
                resolveChromeFocusHandoff({
                    focusLocation: 'nowhere',
                    isOriginRestorable: true,
                    isRevealing: false,
                }),
            ).toEqual({ recordsOrigin: false, target: 'origin' });
        });

        it('leaves focus alone when it sits outside the surface being hidden', () => {
            expect(
                resolveChromeFocusHandoff({
                    focusLocation: 'outside-surface',
                    isOriginRestorable: true,
                    isRevealing: false,
                }),
            ).toEqual({ recordsOrigin: false, target: 'unchanged' });
        });
    });
});
