import type { SourceControlResource } from '@caxri/protocol';
import { compareTreeNodesDirectoriesFirst } from '@caxri/utils';

interface SourceControlTreeDirectory {
    children: SourceControlTreeNode[];
    kind: 'directory';
    name: string;
    path: string;
}

interface SourceControlTreeResource {
    kind: 'file';
    name: string;
    path: string;
    resource: SourceControlResource;
}

export type SourceControlTreeNode = SourceControlTreeDirectory | SourceControlTreeResource;

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
    const sort = (directory: SourceControlTreeDirectory): void => {
        directory.children = directory.children.toSorted(compareTreeNodesDirectoriesFirst);
        for (const child of directory.children) if (child.kind === 'directory') sort(child);
    };
    sort(root);
    return root.children;
}
