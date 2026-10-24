/**
 * How a reading is judged, mapped to the semantic status colors by the views.
 */
export type MonitorTone = 'bad' | 'good' | 'idle' | 'warn';

const GOOD_FPS = 50;
const WARN_FPS = 30;
const GOOD_FRAME_MS = 20;
const WARN_FRAME_MS = 34;

/**
 * One decimal place, the precision Chromium's own frame rate HUD prints (`69.6`).
 */
export function formatFps(fps: number): string {
    return fps.toFixed(1);
}

export function fpsTone(fps: number): MonitorTone {
    if (fps <= 0) return 'idle';
    if (fps >= GOOD_FPS) return 'good';
    return fps >= WARN_FPS ? 'warn' : 'bad';
}

/**
 * Judges one frame by its duration, so the bar graph colors a dropped frame without needing the rate.
 */
export function frameTone(frameMs: number): MonitorTone {
    if (frameMs <= GOOD_FRAME_MS) return 'good';
    return frameMs <= WARN_FRAME_MS ? 'warn' : 'bad';
}

export function formatMegabytes(megabytes: number): string {
    return `${megabytes.toFixed(1)} MB`;
}

export function formatCpu(percent: number): string {
    return `${percent.toFixed(1)}%`;
}

export function formatMilliseconds(milliseconds: number): string {
    if (milliseconds >= 1_000) return `${(milliseconds / 1_000).toFixed(2)} s`;
    return `${milliseconds.toFixed(milliseconds >= 100 ? 0 : 1)} ms`;
}

/**
 * Keeps a dragged card on screen. `position` is the card's top-left in viewport pixels; the result is the nearest
 * position that leaves the whole card inside the viewport, even after the window shrank or the zoom changed.
 */
export function clampOverlayPosition(
    position: { x: number; y: number },
    card: { height: number; width: number },
    viewport: { height: number; width: number },
): { x: number; y: number } {
    const maxX = Math.max(0, viewport.width - card.width);
    const maxY = Math.max(0, viewport.height - card.height);
    return {
        x: Math.min(Math.max(position.x, 0), maxX),
        y: Math.min(Math.max(position.y, 0), maxY),
    };
}
