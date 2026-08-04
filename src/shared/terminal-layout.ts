import type {
    TerminalGroupNode,
    TerminalLayout,
    TerminalLayoutNode,
    TerminalSplitNode,
} from './types';

export type LayoutIdFactory = () => string;

const createId: LayoutIdFactory = () => globalThis.crypto.randomUUID();

function group(terminalId: string, id: LayoutIdFactory): TerminalGroupNode {
    return {
        type: 'group',
        id: id(),
        terminalIds: [terminalId],
        activeTerminalId: terminalId,
    };
}

function firstGroup(node?: TerminalLayoutNode): TerminalGroupNode | undefined {
    if (!node) return undefined;
    return node.type === 'group' ? node : (firstGroup(node.first) ?? firstGroup(node.second));
}

function findGroup(
    node: TerminalLayoutNode | undefined,
    groupId: string,
): TerminalGroupNode | undefined {
    if (!node) return undefined;
    if (node.type === 'group') return node.id === groupId ? node : undefined;
    return findGroup(node.first, groupId) ?? findGroup(node.second, groupId);
}

function findTerminalGroup(
    node: TerminalLayoutNode | undefined,
    terminalId: string,
): TerminalGroupNode | undefined {
    if (!node) return undefined;
    if (node.type === 'group') return node.terminalIds.includes(terminalId) ? node : undefined;
    return findTerminalGroup(node.first, terminalId) ?? findTerminalGroup(node.second, terminalId);
}

function replaceNode(
    node: TerminalLayoutNode,
    nodeId: string,
    replacement: (node: TerminalLayoutNode) => TerminalLayoutNode,
): TerminalLayoutNode {
    if (node.id === nodeId) return replacement(node);
    if (node.type === 'group') return node;
    const first = replaceNode(node.first, nodeId, replacement);
    const second = replaceNode(node.second, nodeId, replacement);
    return first === node.first && second === node.second ? node : { ...node, first, second };
}

function removeFromNode(
    node: TerminalLayoutNode,
    terminalId: string,
): TerminalLayoutNode | undefined {
    if (node.type === 'group') {
        if (!node.terminalIds.includes(terminalId)) return node;
        const terminalIds = node.terminalIds.filter((id) => id !== terminalId);
        if (terminalIds.length === 0) return undefined;
        return {
            ...node,
            terminalIds,
            activeTerminalId:
                node.activeTerminalId === terminalId ? terminalIds.at(-1) : node.activeTerminalId,
        };
    }
    const first = removeFromNode(node.first, terminalId);
    const second = removeFromNode(node.second, terminalId);
    if (!first) return second;
    if (!second) return first;
    return first === node.first && second === node.second ? node : { ...node, first, second };
}

function withValidActiveGroup(layout: TerminalLayout): TerminalLayout {
    if (layout.activeGroupId && findGroup(layout.root, layout.activeGroupId)) return layout;
    return { ...layout, activeGroupId: firstGroup(layout.root)?.id };
}

export function createTerminalLayout(
    terminalId: string,
    id: LayoutIdFactory = createId,
): TerminalLayout {
    const root = group(terminalId, id);
    return { root, activeGroupId: root.id };
}

export function listLayoutTerminalIds(layout: TerminalLayout): string[] {
    const terminalIds: string[] = [];
    const visit = (node?: TerminalLayoutNode): void => {
        if (!node) return;
        if (node.type === 'group') {
            terminalIds.push(...node.terminalIds);
            return;
        }
        visit(node.first);
        visit(node.second);
    };
    visit(layout.root);
    return terminalIds;
}

export function firstLayoutTerminalId(layout: TerminalLayout): string | undefined {
    return firstGroup(layout.root)?.activeTerminalId ?? firstGroup(layout.root)?.terminalIds[0];
}

export function selectTerminal(layout: TerminalLayout, terminalId: string): TerminalLayout {
    const target = findTerminalGroup(layout.root, terminalId);
    if (!target || !layout.root) return layout;
    return {
        root: replaceNode(layout.root, target.id, (node) => ({
            ...(node as TerminalGroupNode),
            activeTerminalId: terminalId,
        })),
        activeGroupId: target.id,
    };
}

export function addTerminal(
    layout: TerminalLayout,
    terminalId: string,
    groupId = layout.activeGroupId,
    id: LayoutIdFactory = createId,
): TerminalLayout {
    if (findTerminalGroup(layout.root, terminalId)) return selectTerminal(layout, terminalId);
    if (!layout.root) return createTerminalLayout(terminalId, id);
    const target = (groupId && findGroup(layout.root, groupId)) ?? firstGroup(layout.root);
    if (!target) return createTerminalLayout(terminalId, id);
    return {
        root: replaceNode(layout.root, target.id, (node) => {
            const groupNode = node as TerminalGroupNode;
            return {
                ...groupNode,
                terminalIds: [...groupNode.terminalIds, terminalId],
                activeTerminalId: terminalId,
            };
        }),
        activeGroupId: target.id,
    };
}

export function removeTerminal(layout: TerminalLayout, terminalId: string): TerminalLayout {
    if (!layout.root) return layout;
    return withValidActiveGroup({
        ...layout,
        root: removeFromNode(layout.root, terminalId),
    });
}

export function moveTerminal(
    layout: TerminalLayout,
    terminalId: string,
    targetGroupId: string,
): TerminalLayout {
    const source = findTerminalGroup(layout.root, terminalId);
    if (!source || !findGroup(layout.root, targetGroupId)) return layout;
    if (source.id === targetGroupId) return selectTerminal(layout, terminalId);
    const removed = removeTerminal(layout, terminalId);
    return addTerminal(removed, terminalId, targetGroupId);
}

export function splitTerminal(
    layout: TerminalLayout,
    terminalId: string,
    targetGroupId: string,
    direction: TerminalSplitNode['direction'],
    id: LayoutIdFactory = createId,
): TerminalLayout {
    const source = findTerminalGroup(layout.root, terminalId);
    if (source?.id === targetGroupId && source.terminalIds.length === 1) return layout;
    const removed = source ? removeTerminal(layout, terminalId) : layout;
    if (!removed.root || !findGroup(removed.root, targetGroupId)) return layout;
    const nextGroup = group(terminalId, id);
    const splitId = id();
    return {
        root: replaceNode(removed.root, targetGroupId, (target) => ({
            type: 'split',
            id: splitId,
            direction,
            ratio: 0.5,
            first: target,
            second: nextGroup,
        })),
        activeGroupId: nextGroup.id,
    };
}

export function resizeSplit(
    layout: TerminalLayout,
    splitId: string,
    ratio: number,
): TerminalLayout {
    if (!layout.root) return layout;
    const boundedRatio = Math.min(0.85, Math.max(0.15, ratio));
    return {
        ...layout,
        root: replaceNode(layout.root, splitId, (node) =>
            node.type === 'split' ? { ...node, ratio: boundedRatio } : node,
        ),
    };
}
