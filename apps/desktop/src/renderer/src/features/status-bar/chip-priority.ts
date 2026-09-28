/**
 * Priority-based responsive hiding for the status bar's right-hand ("actions") group.
 *
 * Below the window width where every chip fits, the bar used to fall back to a raw horizontal scrollbar (see the
 * `statusbar-actions` comment in `status-bar.tsx`) — a real but easy-to-miss affordance. Instead, chips are dropped one
 * at a time as the container narrows, in an order that protects the information a user cannot get anywhere else in the
 * status bar:
 *
 * - The child-process count and memory chips duplicate a live reading already available in Process Explorer
 *   (`processExplorer.open`), so they are the cheapest to hide first.
 * - The Linear issue chip goes next: it is a pointer to a tracker outside Caxri, and the same issue is reachable from the
 *   Status panel's own Linear rows.
 * - The acceptance chip survives one step longer than Linear. Both point outside Caxri and both repeat a Status panel
 *   row, but this one is the only place in the bar that says whether the work the Session just did actually passed —
 *   the reading a user checks most often while a verification round is running.
 * - The pull request chip duplicates the Git panel, so it goes after that.
 * - The notification bell, degraded-backend/runtime chips, active Terminal progress, the update chip, the open debugging
 *   channel chip, the count of peer messages awaiting approval, and the Project root + branch pickers are never
 *   included here — they have no other on-screen home and must never disappear silently. The update chip is the only
 *   persistent trace of a download in flight or an install waiting, because automatic discovery now raises a
 *   notification that expires rather than a dialog that holds the screen. The debugging chip is a security disclosure:
 *   a window narrow enough to hide it is not a reason to stop telling the user that anything on this Mac can attach to
 *   Caxri. The approval count stands for senders still blocked on the user's answer, so a narrow window is no reason to
 *   hide it either. The overflow scrollbar stays as the absolute last resort for the pathological case where even that
 *   never-hide set doesn't fit.
 */
export interface ChipVisibility {
    acceptance: boolean;
    childProcessCount: boolean;
    linearIssue: boolean;
    memory: boolean;
    pullRequest: boolean;
}

/**
 * Width thresholds (px) below which a chip is dropped, ordered lowest-priority-first. Spaced ~60-90px apart — roughly
 * one chip's rendered width — so a single resize step only ever changes one chip's visibility. 752px is the original
 * raw-scrollbar-fallback threshold this replaces.
 */
export const CHIP_PRIORITY_BREAKPOINTS = {
    childProcessCount: 752,
    memory: 680,
    linearIssue: 610,
    acceptance: 545,
    pullRequest: 480,
} as const;

const ALL_VISIBLE: ChipVisibility = {
    acceptance: true,
    childProcessCount: true,
    linearIssue: true,
    memory: true,
    pullRequest: true,
};

/**
 * Pure width -> visibility resolution, kept independent of measurement so it stays unit-testable without a DOM. `width
 * <= 0` (not yet measured) resolves to fully visible so the bar renders its normal contents before the first
 * `ResizeObserver` callback lands.
 */
export function resolveChipVisibility(width: number): ChipVisibility {
    if (width <= 0) return ALL_VISIBLE;
    return {
        acceptance: width >= CHIP_PRIORITY_BREAKPOINTS.acceptance,
        childProcessCount: width >= CHIP_PRIORITY_BREAKPOINTS.childProcessCount,
        linearIssue: width >= CHIP_PRIORITY_BREAKPOINTS.linearIssue,
        memory: width >= CHIP_PRIORITY_BREAKPOINTS.memory,
        pullRequest: width >= CHIP_PRIORITY_BREAKPOINTS.pullRequest,
    };
}
