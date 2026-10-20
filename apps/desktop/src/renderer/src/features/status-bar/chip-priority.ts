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
 * - A chip in its warning state (`ChipFit.urgent`, today the usage chip once a limit is nearly spent or running ahead of
 *   pace) leaves the order above and is dropped after every calm chip, because hiding a warning defeats it.
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
 * The chips hidden by priority. A hidden chip still renders, out of the bar's layout (`PriorityChipSlot`), so its
 * current width stays measurable.
 */
export type HiddenChips = ReadonlySet<DroppableChip>;

export const NO_HIDDEN_CHIPS: HiddenChips = new Set();

/**
 * One layout measurement of the bar.
 */
export interface ChipFit {
    /**
     * Content-box width the bar has.
     */
    available: number;
    /**
     * Width the bar's in-flow content needs at natural size: the chips shown in the bar, not the hidden ones.
     */
    required: number;
    /**
     * Current width (gap included) of each droppable chip with something to show, shown or hidden; a chip with nothing
     * to show is absent.
     */
    chips: Partial<Record<DroppableChip, number>>;
    /**
     * Chips currently showing a warning. They are dropped after every chip that is not, keeping their relative order.
     */
    urgent?: ReadonlySet<DroppableChip>;
}

/**
 * {@link CHIP_DROP_ORDER} with the urgent chips moved to the end, so a warning outlasts the calm chips.
 */
export function chipDropOrder(urgent: ReadonlySet<DroppableChip> | undefined): DroppableChip[] {
    if (!urgent || urgent.size === 0) return [...CHIP_DROP_ORDER];
    return [
        ...CHIP_DROP_ORDER.filter((chip) => !urgent.has(chip)),
        ...CHIP_DROP_ORDER.filter((chip) => urgent.has(chip)),
    ];
}

/**
 * Which chips to hide so the bar's content fits, dropping lowest priority first. Pure, so it stays unit-testable
 * without a DOM.
 *
 * The answer does not depend on which chips happen to be hidden right now, only on their current widths: a hidden chip
 * is measured where it renders out of the layout, which is what lets a widening bar bring it back once it fits and
 * keeps a bar near the threshold from flickering a chip in and out. A chip with nothing to show (an Agent's output
 * speed after the Agent exits) measures as absent, shown or hidden, so it never holds room the other chips could use.
 */
export function resolveHiddenChips(fit: ChipFit, hidden: HiddenChips): HiddenChips {
    const order = chipDropOrder(fit.urgent);
    const widths = order.map((chip) => fit.chips[chip] ?? 0);
    let total = fit.required;
    for (const [index, chip] of order.entries()) if (hidden.has(chip)) total += widths[index];
    const next = new Set<DroppableChip>();
    for (const [index, chip] of order.entries()) {
        if (total <= fit.available) break;
        const width = widths[index];
        if (width <= 0) continue;
        next.add(chip);
        total -= width;
    }
    return next;
}

/**
 * True when two hidden sets hide the same chips.
 */
export function isSameHiddenChips(left: HiddenChips, right: HiddenChips): boolean {
    if (left.size !== right.size) return false;
    for (const chip of left) if (!right.has(chip)) return false;
    return true;
}

export function chipVisibility(hidden: HiddenChips): ChipVisibility {
    return Object.fromEntries(CHIP_DROP_ORDER.map((chip) => [chip, !hidden.has(chip)])) as Record<
        DroppableChip,
        boolean
    >;
}
