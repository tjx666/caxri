/**
 * A `--foreground` dot drawn into a 24-unit Lucide glyph's top-right corner, marking a status-bar chip whose subject is
 * not the checked-out root or branch: the Workbench Root picker while the conversation worked in another worktree, and
 * the pull request chip for a pull request on another branch. It is drawn into the glyph, as the throughput chip's
 * provider dot is, so the chip keeps its width as it comes and goes. It is not `--accent`: a passive hint must not
 * compete with the one durable accent focus (DESIGN.md Principle 2).
 *
 * Lucide drops its default `aria-hidden` once an icon has children, so the host glyph must restore it; the chip's
 * accessible name says the same thing in words.
 */
export function MismatchDot() {
    return (
        <circle
            className="fill-foreground stroke-surface [.statusbar-item:hover_&]:stroke-[color-mix(in_srgb,var(--foreground)_10%,var(--surface))]"
            cx={19}
            cy={5}
            r={4.5}
            strokeWidth={2}
        />
    );
}
