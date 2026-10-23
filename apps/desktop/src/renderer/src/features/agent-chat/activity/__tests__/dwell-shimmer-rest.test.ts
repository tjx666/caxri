import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DWELL_SHIMMER_RESTING_ATTRIBUTE, installDwellShimmerRest } from '../dwell-shimmer-rest';

class FakeElement extends EventTarget {
    readonly attributes = new Set<string>();

    setAttribute(name: string): void {
        this.attributes.add(name);
    }

    removeAttribute(name: string): void {
        this.attributes.delete(name);
    }
}

function animationEnd(target: FakeElement, animationName: string): void {
    const event = Object.assign(new Event('animationend', { bubbles: true }), { animationName });
    // A fake tree has no bubbling path, so deliver straight to the document listener with the shimmer as target.
    Object.defineProperty(event, 'target', { value: target });
    document.dispatchEvent(event);
}

describe('installDwellShimmerRest', () => {
    let teardown: () => void;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('Element', FakeElement);
        vi.stubGlobal('document', Object.assign(new EventTarget(), { documentElement: {} }));
        vi.stubGlobal('getComputedStyle', () => ({
            getPropertyValue: (token: string) =>
                token === '--motion-activity-dwell-rest' ? '2600ms' : '',
        }));
        teardown = installDwellShimmerRest();
    });

    afterEach(() => {
        teardown();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('rests a shimmer without an animation after its sweep, then lets it sweep again', () => {
        const shimmer = new FakeElement();

        animationEnd(shimmer, 'activity-dwell-shimmer');
        expect(shimmer.attributes.has(DWELL_SHIMMER_RESTING_ATTRIBUTE)).toBe(true);

        vi.advanceTimersByTime(2599);
        expect(shimmer.attributes.has(DWELL_SHIMMER_RESTING_ATTRIBUTE)).toBe(true);
        vi.advanceTimersByTime(1);
        expect(shimmer.attributes.has(DWELL_SHIMMER_RESTING_ATTRIBUTE)).toBe(false);
    });

    it('ignores other animations ending', () => {
        const element = new FakeElement();

        animationEnd(element, 'activity-shimmer');

        expect(element.attributes.size).toBe(0);
    });

    it('cancels pending restarts on teardown', () => {
        const shimmer = new FakeElement();
        animationEnd(shimmer, 'activity-dwell-shimmer');

        teardown();
        vi.advanceTimersByTime(2600);

        expect(shimmer.attributes.has(DWELL_SHIMMER_RESTING_ATTRIBUTE)).toBe(true);
        teardown = () => {};
    });
});
