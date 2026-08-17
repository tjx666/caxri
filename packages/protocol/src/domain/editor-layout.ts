import { z } from 'zod';

import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from './layout.js';

/**
 * Editor layout trees mirror the Terminal split-layout shape (`./layout.js`) but carry file `path` identities instead
 * of Terminal ids. Unlike Terminals, the same `path` may legitimately appear in more than one group — VS Code allows
 * opening one file side-by-side in two panes — so, deliberately unlike `terminalLayoutSchema`, this schema does not
 * enforce a globally unique attachment per path. A path is still required to be unique _within_ one group, since a
 * single pane listing the same tab twice has no meaning.
 */
export interface EditorGroupNode {
    type: 'group';
    id: string;
    paths: string[];
    activePath?: string;
}

export interface EditorSplitNode {
    type: 'split';
    id: string;
    direction: 'horizontal' | 'vertical';
    ratio: number;
    first: EditorLayoutNode;
    second: EditorLayoutNode;
}

export type EditorLayoutNode = EditorGroupNode | EditorSplitNode;

/**
 * Monaco editor instances are far heavier than Terminal panes (language services, model workers, decorations), so the
 * Editor split tree is capped well below `MAX_LAYOUT_NODES`/`MAX_LAYOUT_TERMINALS` in `./layout.ts`: at most 8 live
 * groups (panes), which bounds the binary tree at 15 nodes (`2 * groups - 1`).
 */
export const MAX_EDITOR_LAYOUT_GROUPS = 8;
const MAX_EDITOR_LAYOUT_NODES = MAX_EDITOR_LAYOUT_GROUPS * 2 - 1;

const editorLayoutId = z.string().min(1).max(200);
const editorLayoutPath = z.string().min(1).max(16_384);

const editorGroupNodeSchema: z.ZodType<EditorGroupNode, EditorGroupNode> = z.object({
    type: z.literal('group'),
    id: editorLayoutId,
    paths: z.array(editorLayoutPath).min(1),
    activePath: editorLayoutPath.optional(),
});

// eslint-disable-next-line prefer-const -- mutually recursive with `editorSplitNodeSchema` below; must be forward-declared and assigned after it to satisfy no-use-before-define, so a single later assignment is unavoidable.
let editorLayoutNodeSchema: z.ZodType<EditorLayoutNode, EditorLayoutNode>;

const editorSplitNodeSchema: z.ZodType<EditorSplitNode, EditorSplitNode> = z.object({
    type: z.literal('split'),
    id: editorLayoutId,
    direction: z.enum(['horizontal', 'vertical']),
    ratio: z.number().min(MIN_SPLIT_RATIO).max(MAX_SPLIT_RATIO),
    first: z.lazy(() => editorLayoutNodeSchema),
    second: z.lazy(() => editorLayoutNodeSchema),
});

editorLayoutNodeSchema = z.union([editorGroupNodeSchema, editorSplitNodeSchema]);

/**
 * Enforces the invariants the tree shape cannot express: bounded node and group counts, unique node identities, no
 * duplicate `path` within one group (paths may still repeat across different groups), a group-local active path, and an
 * active group that actually exists in the persisted tree.
 */
function checkEditorLayoutInvariants(
    layout: { root?: EditorLayoutNode; activeGroupId?: string },
    context: z.RefinementCtx,
): void {
    const fail = (message: string): void => context.addIssue({ code: 'custom', message });
    if (!layout.root) {
        if (layout.activeGroupId !== undefined)
            fail('An empty editor layout cannot have an active group');
        return;
    }
    const nodeIds = new Set<string>();
    const pending: EditorLayoutNode[] = [layout.root];
    let groupCount = 0;
    while (pending.length > 0) {
        if (nodeIds.size >= MAX_EDITOR_LAYOUT_NODES)
            return fail(`Editor layout exceeds ${MAX_EDITOR_LAYOUT_NODES} nodes`);
        const node = pending.pop()!;
        if (nodeIds.has(node.id)) return fail('Editor layout reuses a layout node id');
        nodeIds.add(node.id);
        if (node.type === 'split') {
            pending.push(node.first, node.second);
            continue;
        }
        groupCount += 1;
        if (groupCount > MAX_EDITOR_LAYOUT_GROUPS)
            return fail(`Editor layout exceeds ${MAX_EDITOR_LAYOUT_GROUPS} groups`);
        const groupPaths = new Set<string>();
        for (const path of node.paths) {
            if (groupPaths.has(path)) return fail('A group cannot list the same path twice');
            groupPaths.add(path);
        }
        if (node.activePath !== undefined && !groupPaths.has(node.activePath))
            return fail('The active path must belong to its layout group');
    }
    if (layout.activeGroupId !== undefined && !nodeIds.has(layout.activeGroupId))
        fail('The active group is not part of the Editor layout');
}

export const editorLayoutSchema = z
    .object({
        root: editorLayoutNodeSchema.optional(),
        activeGroupId: editorLayoutId.optional(),
    })
    .superRefine(checkEditorLayoutInvariants);

export type EditorLayout = z.infer<typeof editorLayoutSchema>;
