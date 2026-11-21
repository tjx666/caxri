/**
 * Geometry of the branch guide that ties a host Session's child rows (its subagents and the Sessions it delegated) to
 * the host row, in list-local pixels. Every child row type is a fixed 24px tall and puts its leading glyph 34px from
 * the list's left edge, so one row height describes them all.
 *
 * - The trunk runs under the host's 14px Agent icon (x = the row's 8px inset + half the icon) and starts 3px below it:
 *   the host row is 28px with the icon centered, so its bottom edge sits 7px above the list.
 * - A branch leaves the trunk with a true quarter arc and stops 3px short of the child's glyph.
 */
const SESSION_CHILD_GUIDE = {
    arcRadius: 8,
    branchEnd: 31,
    rowHeight: 24,
    trunkStart: -4,
    trunkX: 15,
} as const;

/**
 * What a child row contributes to the guide: a `branch` row gets an arc to its glyph; a `pass` row (the subagent `Show
 * more` / `Show fewer` toggle, a `Show N more` reveal row) gets none, though the trunk passes it when a branch
 * follows.
 */
export type SessionChildGuideRow = 'branch' | 'pass';

export interface SessionChildGuideInput {
    /**
     * True when another child list follows this one under the same host (subagent rows above delegated Session rows).
     * The trunk then runs to this list's bottom edge less the next list's own overhang, so the two lists draw one
     * continuous line without an overlapping, darker stretch.
     */
    continuesBelow: boolean;
    /**
     * Index of the selected row in `rows`, when it is a `branch` row.
     */
    selectedIndex?: number;
    /**
     * True when the selected child sits in a later list under the same host: the whole trunk of this list then lies on
     * the selected path.
     */
    selectedBelow?: boolean;
    rows: readonly SessionChildGuideRow[];
}

export interface SessionChildGuidePaths {
    /**
     * Total height of the rows, for the SVG box.
     */
    height: number;
    /**
     * The dim guide: the trunk and every branch. Drawn as one faded group so overlapping segments never darken.
     */
    paths: string[];
    /**
     * The brighter path from the host to the selected child (or through this list toward it), when there is one.
     */
    selectedPath?: string;
}

function branchPath(index: number): string {
    const { arcRadius, branchEnd, rowHeight, trunkStart, trunkX } = SESSION_CHILD_GUIDE;
    const centerY = rowHeight * index + rowHeight / 2;
    return `M${trunkX} ${trunkStart} V${centerY - arcRadius} Q${trunkX} ${centerY} ${trunkX + arcRadius} ${centerY} H${branchEnd}`;
}

function trunkPath(toY: number): string {
    const { trunkStart, trunkX } = SESSION_CHILD_GUIDE;
    return `M${trunkX} ${trunkStart} V${toY}`;
}

/**
 * The SVG paths for one child list. A list whose rows hold no branch and that continues to no later list draws nothing.
 */
export function sessionChildGuidePaths({
    continuesBelow,
    rows,
    selectedBelow = false,
    selectedIndex,
}: SessionChildGuideInput): SessionChildGuidePaths {
    const height = rows.length * SESSION_CHILD_GUIDE.rowHeight;
    // The next list starts its own trunk `trunkStart` above its top edge; stop short by exactly that much.
    const continuedEnd = height + SESSION_CHILD_GUIDE.trunkStart;
    const paths: string[] = [];
    rows.forEach((row, index) => {
        if (row === 'branch') paths.push(branchPath(index));
    });
    if (continuesBelow) paths.push(trunkPath(continuedEnd));
    let selectedPath: string | undefined;
    if (continuesBelow && selectedBelow) selectedPath = trunkPath(continuedEnd);
    else if (selectedIndex !== undefined && rows[selectedIndex] === 'branch')
        selectedPath = branchPath(selectedIndex);
    return { height, paths, selectedPath };
}
