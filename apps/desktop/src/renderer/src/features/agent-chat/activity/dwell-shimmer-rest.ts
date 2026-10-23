import { motionDurationMs } from '../../../lib/motion';

/**
 * Marks a dwell shimmer between sweeps. `styles.css` drops the animation while it is present.
 */
export const DWELL_SHIMMER_RESTING_ATTRIBUTE = 'data-activity-shimmer-resting';

const DWELL_SHIMMER_ANIMATION = 'activity-dwell-shimmer';

/**
 * Runs the Agent Chat dwell shimmer's rest phase without an animation.
 *
 * The dwell shimmer sweeps for `--motion-activity-dwell-sweep` and then holds still for `--motion-activity-dwell-rest`.
 * Expressed as one infinite keyframe animation, the hold still ticked: `background-position` is not composited, so
 * Chromium restyled the text every frame of a rest that changes nothing (three shimmers cost about 24 ms of main thread
 * per second on a 120 Hz display). The CSS animation now covers only the sweep and plays once; when it ends, this marks
 * the element as resting, which removes the animation, and clears the mark after the rest so the sweep starts again.
 * The element rests at the sweep's end position, so nothing visible changes.
 *
 * One delegated listener serves every shimmer in the window, including ones mounted later, because `animationend`
 * bubbles. Each Renderer entry that can show Agent Chat installs it before mounting React; only tests tear it down.
 *
 * @returns A teardown that stops scheduling and clears pending restarts.
 */
export function installDwellShimmerRest(): () => void {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const handleAnimationEnd = (event: AnimationEvent): void => {
        if (event.animationName !== DWELL_SHIMMER_ANIMATION || !(event.target instanceof Element))
            return;
        const element = event.target;
        element.setAttribute(DWELL_SHIMMER_RESTING_ATTRIBUTE, '');
        const timer = setTimeout(() => {
            timers.delete(timer);
            element.removeAttribute(DWELL_SHIMMER_RESTING_ATTRIBUTE);
        }, motionDurationMs('--motion-activity-dwell-rest'));
        timers.add(timer);
    };
    document.addEventListener('animationend', handleAnimationEnd);
    return () => {
        document.removeEventListener('animationend', handleAnimationEnd);
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
    };
}
