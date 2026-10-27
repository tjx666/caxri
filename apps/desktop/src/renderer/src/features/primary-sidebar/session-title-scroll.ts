/**
 * Reading speed of the reveal, in pixels per second.
 */
const SCROLL_SPEED = 35;
/**
 * Pause before the title starts moving, and hold at its tail, in milliseconds.
 */
const START_DELAY = 600;
const END_HOLD = 1200;

export interface SessionTitleScrollTimeline {
    /**
     * Total animation duration in milliseconds.
     */
    duration: number;
    /**
     * Offset where the text starts sliding.
     */
    slideStart: number;
    /**
     * Offset where the left edge fade reaches full width.
     */
    fadeIn: number;
    /**
     * Offset where the right edge fade starts clearing.
     */
    fadeOut: number;
    /**
     * Offset where the text reaches its tail.
     */
    slideEnd: number;
}

/**
 * Keyframe offsets for revealing a title clipped by `distance` pixels behind an edge fade of `fade` pixels.
 * `Element.animate` throws when offsets decrease, and when the ramp is half the travel the two sides of `fadeIn <=
 * fadeOut` are equal in exact arithmetic but can round apart (a 3px overflow did), which crashed the Renderer. Each
 * offset is therefore clamped to the previous one.
 */
export function sessionTitleScrollTimeline(
    distance: number,
    fade: number,
): SessionTitleScrollTimeline {
    const travel = (distance / SCROLL_SPEED) * 1000;
    const duration = START_DELAY + travel + END_HOLD;
    const ramp = (Math.min(Math.max(fade, 0), distance / 2) / SCROLL_SPEED) * 1000;
    const slideStart = START_DELAY / duration;
    const fadeIn = Math.max(slideStart, (START_DELAY + ramp) / duration);
    const fadeOut = Math.max(fadeIn, (START_DELAY + travel - ramp) / duration);
    const slideEnd = Math.min(1, Math.max(fadeOut, (START_DELAY + travel) / duration));
    return { duration, slideStart, fadeIn, fadeOut, slideEnd };
}
