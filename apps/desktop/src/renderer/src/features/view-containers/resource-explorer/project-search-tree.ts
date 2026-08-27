import type { FileSearchMatch } from '@caxri/protocol';
import { compareTreeNodesDirectoriesFirst } from '@caxri/utils';

interface NameSearchFileNode {
    kind: 'file';
    match: FileSearchMatch;
    name: string;
    relativePath: string;
}

interface NameSearchDirectoryNode {
    kind: 'directory';
    children: NameSearchNode[];
    name: string;
    relativePath: string;
}

export type NameSearchNode = NameSearchDirectoryNode | NameSearchFileNode;

export function groupSearchMatches(
    matches: readonly FileSearchMatch[],
): Map<string, FileSearchMatch[]> {
    const groups = new Map<string, FileSearchMatch[]>();
    for (const match of matches) {
        const group = groups.get(match.relativePath);
        if (group) group.push(match);
        else groups.set(match.relativePath, [match]);
    }
    return groups;
}

function sortNameNodes(nodes: NameSearchNode[]): void {
    nodes.sort(compareTreeNodesDirectoriesFirst);
    for (const node of nodes) if (node.kind === 'directory') sortNameNodes(node.children);
}

export function buildNameSearchTree(matches: readonly FileSearchMatch[]): NameSearchNode[] {
    const roots: NameSearchNode[] = [];
    for (const match of matches) {
        const segments = match.relativePath.split('/').filter(Boolean);
        let nodes = roots;
        for (let index = 0; index < segments.length - 1; index += 1) {
            const relativePath = segments.slice(0, index + 1).join('/');
            let directory = nodes.find(
                (node): node is NameSearchDirectoryNode =>
                    node.kind === 'directory' && node.relativePath === relativePath,
            );
            if (!directory) {
                directory = {
                    kind: 'directory',
                    children: [],
                    name: segments[index],
                    relativePath,
                };
                nodes.push(directory);
            }
            nodes = directory.children;
        }
        const name = segments.at(-1) ?? match.relativePath;
        nodes.push({ kind: 'file', match, name, relativePath: match.relativePath });
    }
    sortNameNodes(roots);
    return roots;
}
