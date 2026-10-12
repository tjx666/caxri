/**
 * Priority-based responsive hiding for the status bar.
 *
 * DESIGN.md's status bar redline drops whole chips one at a time, lowest first, when the window is too narrow; it never
 * truncates a chip's label. Every status-bar item therefore keeps its natural width (`flex-none`), and the chips below
 * are dropped as needed to make the bar's content fit, in an order that protects the information a user cannot get
 * anywhere else in the status bar:
 *
 * - The child-process count and memory chips duplicate a live reading already available in Process Explorer
 *   (`processExplorer.open`), so they are the cheapest to hide first.
 * - The active Agent's output speed goes next. Nothing else on screen shows it, but it is a gauge the user glances at,
 *   not something they act on, so it yields before the chips that point at the branch's delivery state.
 * - The active Agent conversation's usage (tokens, estimated cost, rate-limit window) outlasts the output speed: the
 *   Usage page shows the same numbers only across conversations, and the limit window is what a user checks before
 *   starting more work. It still yields before the chips that point at the branch's delivery state.
 * - The Linear issue chip goes next: it is a pointer to a tracker outside Caxri, and the same issue is reachable from the
 *   Status panel's own Linear rows.
 * - The acceptance chip survives one step longer than Linear. Both point outside Caxri and both repeat a Status panel
 *   row, but this one is the only place in the bar that says whether the work the Session just did actually passed: the
 *   reading a user checks most often while a verification round is running.
 * - The pull request chip duplicates the Git panel, so it goes after that.
 * - Everything else is never included here: the notification bell, degraded-backend/runtime chips, active Terminal
 *   progress, the update chip, the open debugging channel chip, the Agent Commander chips, the count of peer messages
 *   awaiting approval, the change counter, and the Project root + branch pickers. They have no other on-screen home and
 *   must never disappear silently. The update chip is the only persistent trace of a download in flight or an install
 *   waiting. The debugging chip is a security disclosure: a window narrow enough to hide it is not a reason to stop
 *   telling the user that anything on this Mac can attach to Caxri. The approval count and the Commander's "Needs you"
 *   count stand for questions still waiting on the user. The pickers cap their own width instead (a long branch name
 *   truncates at that cap), and the overflow scrollbar stays as the absolute last resort for the pathological case
 *   where even that never-hide set doesn't fit.
 *
 * The chips are dropped by measured width rather than at fixed window-width breakpoints: which chips are present (an
 * Agent's two chips, a Commander chip, a debugging disclosure) changes how much room the rest needs, and a fixed
 * breakpoint calibrated without them is what let `Commander idle` and `Debug port` shrink to `Com…` and `De…`.
 */
export const CHIP_DROP_ORDER = [
    'childProcessCount',
    'memory',
    'agentThroughput',
    'agentUsage',
    'linearIssue',
    'acceptance',
    'pullRequest',
] as const;

export type DroppableChip = (typeof CHIP_DROP_ORDER)[number];

export type ChipVisibility = Readonly<Record<DroppableChip, boolean>>;

/**
 * Hidden chips, each with the width (gap included) it last occupied, so the bar can tell when it fits again.
 */
export type HiddenChips = ReadonlyMap<DroppableChip, number>;

export const NO_HIDDEN_CHIPS: HiddenChips = new Map();

/**
 * One layout measurement of the bar.
 */
export interface ChipFit {
    /**
     * Content-box width the bar has.
     */
    available: number;
    /**
     * Width the bar's content needs at natural size, with the chips currently rendered.
     */
    required: number;
    /**
     * Width (gap included) of each droppable chip currently rendered; a chip with nothing to show is absent.
     */
    rendered: Partial<Record<DroppableChip, number>>;
}

/**
 * Which chips to hide so the bar's content fits, dropping lowest priority first. Pure, so it stays unit-testable
 * without a DOM.
 *
 * The answer does not depend on which chips happen to be hidden right now, only on their widths: a currently hidden
 * chip counts with the width it last occupied, which is what lets a widening bar bring it back once it fits and keeps a
 * bar near the threshold from flickering a chip in and out. A chip that renders nothing is never hidden, because hiding
 * it frees no room.
 */
export function resolveHiddenChips(fit: ChipFit, hidden: HiddenChips): HiddenChips {
    let renderedTotal = 0;
    for (const width of Object.values(fit.rendered)) renderedTotal += width;
    const widths = CHIP_DROP_ORDER.map((chip) => fit.rendered[chip] ?? hidden.get(chip) ?? 0);
    let total = fit.required - renderedTotal;
    for (const width of widths) total += width;
    const next = new Map<DroppableChip, number>();
    for (const [index, chip] of CHIP_DROP_ORDER.entries()) {
        if (total <= fit.available) break;
        const width = widths[index];
        if (width <= 0) continue;
        next.set(chip, width);
        total -= width;
    }
    return next;
}

/**
 * True when two hidden sets hide the same chips. Remembered widths are not compared, so a chip whose width moved by a
 * pixel while hidden does not re-render the bar.
 */
export function isSameHiddenChips(left: HiddenChips, right: HiddenChips): boolean {
    if (left.size !== right.size) return false;
    for (const chip of left.keys()) if (!right.has(chip)) return false;
    return true;
}

export function chipVisibility(hidden: HiddenChips): ChipVisibility {
    return Object.fromEntries(CHIP_DROP_ORDER.map((chip) => [chip, !hidden.has(chip)])) as Record<
        DroppableChip,
        boolean
    >;
}
