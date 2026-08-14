import { z } from 'zod';

/** Terminal layout trees are recursive, so the node shapes are declared once and reused by `z.lazy`. */
export interface TerminalGroupNode {
    type: 'group';
    id: string;
    terminalIds: string[];
    activeTerminalId?: string;
}

export interface TerminalSplitNode {
    type: 'split';
    id: string;
    direction: 'horizontal' | 'vertical';
    ratio: number;
    first: TerminalLayoutNode;
    second: TerminalLayoutNode;
}

export type TerminalLayoutNode = TerminalGroupNode | TerminalSplitNode;

const MAX_LAYOUT_NODES = 31;
const MAX_LAYOUT_TERMINALS = 16;
export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;

const layoutId = z.string().min(1).max(200);

const terminalGroupNodeSchema: z.ZodType<TerminalGroupNode, TerminalGroupNode> = z.object({
    type: z.literal('group'),
    id: layoutId,
    terminalIds: z.array(layoutId).min(1),
    activeTerminalId: layoutId.optional(),
});

const terminalSplitNodeSchema: z.ZodType<TerminalSplitNode, TerminalSplitNode> = z.object({
    type: z.literal('split'),
    id: layoutId,
    direction: z.enum(['horizontal', 'vertical']),
    ratio: z.number().min(MIN_SPLIT_RATIO).max(MAX_SPLIT_RATIO),
    first: z.lazy(() => terminalLayoutNodeSchema),
    second: z.lazy(() => terminalLayoutNodeSchema),
});

const terminalLayoutNodeSchema: z.ZodType<TerminalLayoutNode, TerminalLayoutNode> = z.union([
    terminalGroupNodeSchema,
    terminalSplitNodeSchema,
]);

/**
 * Enforces the invariants the tree shape cannot express: bounded node and Terminal counts, unique
 * node identities, one attachment per Terminal, a group-local active Terminal, and an active group
 * that actually exists in the persisted tree.
 */
function checkLayoutInvariants(
    layout: { root?: TerminalLayoutNode; activeGroupId?: string },
    ctx: z.RefinementCtx,
): void {
    const fail = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (!layout.root) return;
    const nodeIds = new Set<string>();
    const terminalIds = new Set<string>();
    const pending: TerminalLayoutNode[] = [layout.root];
    let terminalCount = 0;
    while (pending.length > 0) {
        if (nodeIds.size >= MAX_LAYOUT_NODES)
            return fail(`Terminal layout exceeds ${MAX_LAYOUT_NODES} nodes`);
        const node = pending.pop()!;
        if (nodeIds.has(node.id)) return fail('Terminal layout reuses a layout node id');
        nodeIds.add(node.id);
        if (node.type === 'split') {
            pending.push(node.first, node.second);
            continue;
        }
        const groupTerminalIds = new Set<string>();
        for (const terminalId of node.terminalIds) {
            if (terminalIds.has(terminalId))
                return fail('A Terminal cannot be attached to two layout groups');
            terminalIds.add(terminalId);
            groupTerminalIds.add(terminalId);
        }
        terminalCount += node.terminalIds.length;
        if (terminalCount > MAX_LAYOUT_TERMINALS)
            return fail(`Terminal layout exceeds ${MAX_LAYOUT_TERMINALS} Terminals`);
        if (node.activeTerminalId !== undefined && !groupTerminalIds.has(node.activeTerminalId))
            return fail('The active Terminal must belong to its layout group');
    }
    if (layout.activeGroupId !== undefined && !nodeIds.has(layout.activeGroupId))
        fail('The active group is not part of the Terminal layout');
}

export const terminalLayoutSchema = z
    .object({
        root: terminalLayoutNodeSchema.optional(),
        activeGroupId: layoutId.optional(),
    })
    .superRefine(checkLayoutInvariants);

export type TerminalLayout = z.infer<typeof terminalLayoutSchema>;
