import { z } from 'zod';

/**
 * A split keeps both sides usable: below these bounds a pane is too narrow to show a Terminal line or an editor gutter.
 */
export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;

/**
 * The single Workbench split tree, replacing the mutually exclusive Terminal (`./layout.js`) and Editor
 * (`./editor-layout.js`) trees. Every leaf is a pane with its own tab bar; a tab's resource decides only what the pane
 * renders, never how the tree splits, reorders, or closes. See `docs/adr/0002-unified-pane-layout.md`.
 */
export type PaneResource =
    { kind: 'terminal'; terminalId: string } | { kind: 'file'; path: string };

/**
 * One appearance of a resource in one pane.
 *
 * `id` is occurrence identity (ordering, selection, close, DOM ids, and motion all key off it) while `resource` is
 * content identity, owning the PTY process or the document model and its dirty buffer. Keeping them apart is what lets
 * the same file sit in two panes with independent cursors, and what stops closing one occurrence from closing both.
 */
export interface PaneTab {
    id: string;
    resource: PaneResource;
    /**
     * A single-click preview tab, replaced by the next preview instead of accumulating. Only repeatable resources take
     * part; a Terminal is never a preview.
     */
    preview?: boolean;
}

export interface PaneNode {
    type: 'pane';
    id: string;
    tabs: PaneTab[];
    activeTabId?: string;
}

export interface PaneSplitNode {
    type: 'split';
    id: string;
    direction: 'horizontal' | 'vertical';
    ratio: number;
    first: PaneLayoutNode;
    second: PaneLayoutNode;
}

export type PaneLayoutNode = PaneNode | PaneSplitNode;

/**
 * A pane can hold a Monaco instance with its own language services, so the tree stays at the Editor tree's bound rather
 * than the Terminal tree's: 8 live panes, which caps the binary tree at 15 nodes (`2 * panes - 1`).
 */
export const MAX_PANE_LAYOUT_PANES = 8;
const MAX_PANE_LAYOUT_NODES = MAX_PANE_LAYOUT_PANES * 2 - 1;
export const MAX_TABS_PER_PANE = 32;
/**
 * Terminals stay bounded at the Terminal tree's historical limit: every one of them is a live PTY plus a parsed screen,
 * which documents are not.
 */
export const MAX_PANE_LAYOUT_TERMINALS = 16;

const paneLayoutId = z.string().min(1).max(200);
const paneLayoutPath = z.string().min(1).max(16_384);

const paneResourceSchema: z.ZodType<PaneResource, PaneResource> = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('terminal'), terminalId: paneLayoutId }),
    z.object({ kind: z.literal('file'), path: paneLayoutPath }),
]);

const paneTabSchema: z.ZodType<PaneTab, PaneTab> = z.object({
    id: paneLayoutId,
    resource: paneResourceSchema,
    preview: z.boolean().optional(),
});

const paneNodeSchema: z.ZodType<PaneNode, PaneNode> = z.object({
    type: z.literal('pane'),
    id: paneLayoutId,
    tabs: z.array(paneTabSchema).max(MAX_TABS_PER_PANE),
    activeTabId: paneLayoutId.optional(),
});

// eslint-disable-next-line prefer-const -- mutually recursive with `paneSplitNodeSchema` below; must be forward-declared and assigned after it to satisfy no-use-before-define, so a single later assignment is unavoidable.
let paneLayoutNodeSchema: z.ZodType<PaneLayoutNode, PaneLayoutNode>;

const paneSplitNodeSchema: z.ZodType<PaneSplitNode, PaneSplitNode> = z.object({
    type: z.literal('split'),
    id: paneLayoutId,
    direction: z.enum(['horizontal', 'vertical']),
    ratio: z.number().min(MIN_SPLIT_RATIO).max(MAX_SPLIT_RATIO),
    first: z.lazy(() => paneLayoutNodeSchema),
    second: z.lazy(() => paneLayoutNodeSchema),
});

paneLayoutNodeSchema = z.union([paneNodeSchema, paneSplitNodeSchema]);

/**
 * Canonical content identity, stable across occurrences. Two tabs sharing a key show the same thing and must share the
 * document model, the dirty buffer, and the PTY. A Git diff and an Agent transcript are documents like any other: they
 * ride on the same virtual `file` path they already use elsewhere in the Renderer.
 */
export function paneResourceKey(resource: PaneResource): string {
    return resource.kind === 'terminal'
        ? `terminal:${resource.terminalId}`
        : `file:${resource.path}`;
}

/**
 * Whether a resource may occupy several panes at once.
 *
 * This capability, not the tab's kind, is the only place the layout treats resources differently: a PTY exists once, so
 * a Terminal appears in exactly one pane, while a document can be opened side by side with itself. Drag always moves an
 * occurrence regardless; duplication is a separate command only repeatable resources offer.
 */
export function isRepeatablePaneResource(resource: PaneResource): boolean {
    return resource.kind !== 'terminal';
}

/**
 * A pane's tabs split into the two segments its bar lays out separately: Terminals, which stay anchored at the leading
 * edge, and documents, which scroll behind them. Each segment keeps the relative order it had in `tabs`.
 *
 * The Workbench's subject is the Session's Agent conversation; the documents opened to read alongside it are transient.
 * A single scrolling rail treats both the same and lets a handful of files push the Agent Terminal off screen, so the
 * two are separated here (once, in the layout contract) rather than by a rendering rule the reducer could disagree
 * with. {@link orderPaneTabs} is what keeps `PaneNode.tabs` itself in this order, so keyboard navigation, "Close to the
 * Right", and the visual rail all walk one sequence.
 */
export function partitionPaneTabs(tabs: readonly PaneTab[]): {
    scrolling: PaneTab[];
    sticky: PaneTab[];
} {
    const sticky: PaneTab[] = [];
    const scrolling: PaneTab[] = [];
    for (const tab of tabs) (tab.resource.kind === 'terminal' ? sticky : scrolling).push(tab);
    return { scrolling, sticky };
}

/**
 * {@link partitionPaneTabs} flattened back into one list. A stable partition, so a reorder inside either segment
 * survives and only a cross-segment position is normalized away.
 */
export function orderPaneTabs(tabs: readonly PaneTab[]): PaneTab[] {
    const { scrolling, sticky } = partitionPaneTabs(tabs);
    return sticky.length === 0 || scrolling.length === 0 ? [...tabs] : [...sticky, ...scrolling];
}

/**
 * Enforces what the tree shape cannot: bounded pane, node, and Terminal counts, unique node and tab identities, one
 * pane per Terminal, no resource listed twice inside a single pane, a pane-local active tab, an active pane that exists
 * and is a pane rather than a split, and non-empty panes everywhere except a root pane holding the whole Workbench.
 *
 * Segment order is deliberately not enforced here. {@link orderPaneTabs} establishes it on every write and
 * {@link partitionPaneTabs} is what the bar renders from, so a layout persisted before the segments existed keeps
 * loading and heals on its next tab operation instead of failing validation and costing the user their Workbench.
 */
function checkPaneLayoutInvariants(
    layout: { root: PaneLayoutNode; activePaneId?: string },
    context: z.RefinementCtx,
): void {
    const fail = (message: string): void => context.addIssue({ code: 'custom', message });
    const nodeIds = new Set<string>();
    const paneIds = new Set<string>();
    const tabIds = new Set<string>();
    const terminalKeys = new Set<string>();
    const pending: PaneLayoutNode[] = [layout.root];
    let terminalCount = 0;
    while (pending.length > 0) {
        if (nodeIds.size >= MAX_PANE_LAYOUT_NODES)
            return fail(`Pane layout exceeds ${MAX_PANE_LAYOUT_NODES} nodes`);
        const node = pending.pop()!;
        if (nodeIds.has(node.id)) return fail('Pane layout reuses a layout node id');
        nodeIds.add(node.id);
        if (node.type === 'split') {
            pending.push(node.first, node.second);
            continue;
        }
        paneIds.add(node.id);
        if (paneIds.size > MAX_PANE_LAYOUT_PANES)
            return fail(`Pane layout exceeds ${MAX_PANE_LAYOUT_PANES} panes`);
        if (node.tabs.length === 0 && node !== layout.root)
            return fail('Only a root pane may be empty');
        const paneResourceKeys = new Set<string>();
        for (const tab of node.tabs) {
            if (tabIds.has(tab.id)) return fail('Pane layout reuses a tab id');
            tabIds.add(tab.id);
            const key = paneResourceKey(tab.resource);
            if (paneResourceKeys.has(key))
                return fail('A pane cannot list the same resource twice');
            paneResourceKeys.add(key);
            if (tab.resource.kind === 'terminal') {
                if (terminalKeys.has(key))
                    return fail('A Terminal cannot be attached to two panes');
                terminalKeys.add(key);
                terminalCount += 1;
                if (terminalCount > MAX_PANE_LAYOUT_TERMINALS)
                    return fail(`Pane layout exceeds ${MAX_PANE_LAYOUT_TERMINALS} Terminals`);
            }
        }
        if (node.activeTabId !== undefined && node.tabs.every((tab) => tab.id !== node.activeTabId))
            return fail('The active tab must belong to its pane');
    }
    if (layout.activePaneId !== undefined && !paneIds.has(layout.activePaneId))
        fail('The active pane is not a pane of the Workbench layout');
}

/**
 * A layout always has a root: an empty Workbench is one empty pane, not an absent tree, so every command has somewhere
 * to open into and the Renderer never has to special-case a missing surface.
 */
export const paneLayoutSchema = z
    .object({
        root: paneLayoutNodeSchema,
        activePaneId: paneLayoutId.optional(),
    })
    .superRefine(checkPaneLayoutInvariants);

export type PaneLayout = z.infer<typeof paneLayoutSchema>;
