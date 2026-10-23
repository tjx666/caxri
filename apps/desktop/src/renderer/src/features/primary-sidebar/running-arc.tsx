/**
 * A thin open ring that spins in the surrounding text color, the way Codex marks a working thread. It is deliberately
 * monochrome: a colored arc on every running row reads as a wall of color once several Agents work at once, and the
 * motion alone already separates a working Session from a settled one. The 10px ring sits centered in the 14px status
 * slot, so it shares one vertical line with the attention and pull request glyphs. The dash covers three quarters of
 * the circumference and its round caps eat into the rest, leaving about the opening Codex shows. Reduced motion leaves
 * it still.
 *
 * The spin sits on an HTML wrapper, not the `<svg>`: Chromium runs a transform animation on an inline SVG root on the
 * main thread, restyling every frame (ten running rows cost about 35 ms of main thread per second on a 120 Hz display),
 * while the same animation on an HTML element runs on the compositor (about 3 ms).
 */
export function RunningArc() {
    return (
        <span
            aria-hidden="true"
            className="inline-flex size-2.5 flex-none motion-safe:animate-spin"
            data-session-status-arc=""
        >
            <svg className="size-full" viewBox="0 0 20 20">
                <circle
                    cx="10"
                    cy="10"
                    fill="none"
                    r="8.5"
                    stroke="currentColor"
                    strokeDasharray="40 13.4"
                    strokeLinecap="round"
                    strokeWidth="3"
                />
            </svg>
        </span>
    );
}

/**
 * A running Session waiting on its own background work: the running ring's footprint drawn as a dotted ring that turns
 * slowly, still in `--muted`, so it reads as "working, nothing to watch" next to a live turn's spinning arc. Like
 * Orca's "Monitoring background tasks" and t3code's quiet "Waiting", it never pulses. Reduced motion leaves it still.
 */
export function BackgroundArc() {
    return (
        <span
            aria-hidden="true"
            className="inline-flex size-2.5 flex-none motion-safe:animate-spin motion-safe:[animation-duration:3s]"
            data-session-status-background=""
        >
            <svg className="size-full" viewBox="0 0 20 20">
                <circle
                    cx="10"
                    cy="10"
                    fill="none"
                    r="8.5"
                    stroke="currentColor"
                    strokeDasharray="0.01 6.67"
                    strokeLinecap="round"
                    strokeWidth="3"
                />
            </svg>
        </span>
    );
}
