import type { SourceControlResource } from '@caxri/protocol';
import { collectTreeSubtree, compareTreeNodesDirectoriesFirst } from '@caxri/utils';

interface SourceControlTreeDirectory {
    children: SourceControlTreeNode[];
    kind: 'directory';
    name: string;
    path: string;
    /**
     * Sum of every measured resource beneath the directory; absent when none of them carries line counts.
     */
    lineStats?: SourceControlResource['lineStats'];
}

interface SourceControlTreeResource {
    kind: 'file';
    name: string;
    path: string;
    resource: SourceControlResource;
}

export type SourceControlTreeNode = SourceControlTreeDirectory | SourceControlTreeResource;

function isSourceControlTreeDirectory(
    node: SourceControlTreeNode,
): node is SourceControlTreeDirectory {
    return node.kind === 'directory';
}

function placeResource(root: SourceControlTreeDirectory, resource: SourceControlResource): void {
    const parts = resource.path.split('/').filter(Boolean);
    let directory = root;
    for (const [index, name] of parts.entries()) {
        const path = parts.slice(0, index + 1).join('/');
        if (index === parts.length - 1) {
            directory.children.push({ kind: 'file', name, path: resource.path, resource });
            return;
        }
        let child = directory.children.find(
            (candidate): candidate is SourceControlTreeDirectory =>
                candidate.kind === 'directory' && candidate.name === name,
        );
        if (!child) {
            child = { children: [], kind: 'directory', name, path };
            directory.children.push(child);
        }
        directory = child;
    }
}

/**
 * Sums measured line counts, skipping unmeasured entries; `undefined` when none of them was measured, so a caller shows
 * nothing rather than a false `+0 −0`.
 */
export function sumSourceControlLineStats(
    entries: Iterable<SourceControlResource['lineStats']>,
): SourceControlResource['lineStats'] {
    let total: SourceControlResource['lineStats'];
    for (const entry of entries) {
        if (!entry) continue;
        total = {
            additions: (total?.additions ?? 0) + entry.additions,
            deletions: (total?.deletions ?? 0) + entry.deletions,
        };
    }
    return total;
}

/**
 * Builds a presentation-only directory tree from provider-owned resource paths.
 */
export function buildSourceControlResourceTree(
    resources: readonly SourceControlResource[],
): SourceControlTreeNode[] {
    const root: SourceControlTreeDirectory = {
        children: [],
        kind: 'directory',
        name: '',
        path: '',
    };
    for (const resource of resources) placeResource(root, resource);
    const finish = (directory: SourceControlTreeDirectory): SourceControlResource['lineStats'] => {
        directory.children = directory.children.toSorted(compareTreeNodesDirectoriesFirst);
        const lineStats = sumSourceControlLineStats(
            directory.children.map((child) =>
                child.kind === 'directory' ? finish(child) : child.resource.lineStats,
            ),
        );
        if (lineStats) directory.lineStats = lineStats;
        return lineStats;
    };
    finish(root);
    return root.children;
}

/**
 * Every directory disclosure key a group's resources produce, so a recursive gesture on the group caption or the
 * repository row above it can write the whole subtree in one navigation update instead of one per visible row.
 */
export function sourceControlGroupExpansionKeys(
    resources: readonly SourceControlResource[],
    providerKey: string,
): string[] {
    return buildSourceControlResourceTree(resources).flatMap((node) =>
        sourceControlDirectoryExpansionKeys(node, providerKey),
    );
}

/**
 * Returns the complete eager Source Control directory subtree as persisted disclosure keys.
 */
export function sourceControlDirectoryExpansionKeys(
    node: SourceControlTreeNode,
    providerKey: string,
): string[] {
    if (node.kind !== 'directory') return [];
    return collectTreeSubtree(node, (directory) =>
        directory.children.filter(isSourceControlTreeDirectory),
    ).map((directory) => `${providerKey}:${directory.path}`);
}
