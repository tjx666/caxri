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
 * - The pull request chip duplicates the Git panel, so it goes next.
 * - Degraded-backend/runtime chips, active Terminal progress, and the Project root + branch pickers are never included
 *   here — they have no other on-screen home and must never disappear silently. The overflow scrollbar stays as the
 *   absolute last resort for the pathological case where even that never-hide set doesn't fit.
 */
export interface ChipVisibility {
    childProcessCount: boolean;
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
    pullRequest: 610,
} as const;

const ALL_VISIBLE: ChipVisibility = {
    childProcessCount: true,
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
        childProcessCount: width >= CHIP_PRIORITY_BREAKPOINTS.childProcessCount,
        memory: width >= CHIP_PRIORITY_BREAKPOINTS.memory,
        pullRequest: width >= CHIP_PRIORITY_BREAKPOINTS.pullRequest,
    };
}
