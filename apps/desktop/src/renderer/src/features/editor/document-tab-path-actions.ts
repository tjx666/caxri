import type { GitRepositoryOverview } from '@caxri/protocol';
import { isVirtualEditorTabPath, parseExternalEditorTab, parseGitDiffTab } from '@caxri/protocol';

import { relativePathRoot } from '../../lib/copy-file-path';
import { projectRelativePath } from '../../lib/file-path';
import { resolveRepositoryFilePath as resolveRepoFilePath } from '../../lib/repository-file-path';

type RepoRoot = Pick<GitRepositoryOverview, 'id' | 'rootPath'>;

/**
 * Keeps virtual-resource capabilities and query feedback out of the tab's presentation branches.
 */
export function documentTabPathMenuState(
    path: string,
    query: { isError: boolean; isPending: boolean },
): { isExternal: boolean; showMenu: boolean; unavailableReason: string } {
    const isExternal = Boolean(parseExternalEditorTab(path));
    const diff = parseGitDiffTab(path);
    return {
        isExternal,
        showMenu:
            !isVirtualEditorTabPath(path) || isExternal || Boolean(diff && diff.kind !== 'changes'),
        unavailableReason: query.isError
            ? 'Unable to load repository information'
            : query.isPending
              ? 'Repository information is still loading'
              : 'The file path is unavailable',
    };
}

export interface DocumentTabPathResolution {
    absolutePath: string;
    relativeRoot?: string;
}

/**
 * Resolves a tab resource to a filesystem path and the root used for relative clipboard output.
 *
 * Ordinary editor paths are already absolute and must remain inside the authorized Workbench Project. Single-file Git
 * tabs carry repository-relative paths inside their virtual URI, so their absolute path is reconstructed only from the
 * Server-provided repository root. External documents use only the Main-authorized cached display path; their opaque
 * URI is not a filesystem path. Multi-file changes and transcripts have no one file to copy.
 *
 * The relative root itself is `relativePathRoot`'s decision, shared with the Files tree rows.
 */
export function resolveDocumentTabPath(
    path: string,
    options: {
        externalDisplayPath?: string;
        projectRoot?: string;
        repositories?: readonly RepoRoot[];
    },
): DocumentTabPathResolution | undefined {
    if (parseExternalEditorTab(path))
        return options.externalDisplayPath
            ? { absolutePath: options.externalDisplayPath }
            : undefined;
    const diffTab = parseGitDiffTab(path);
    if (diffTab) {
        if (diffTab.kind === 'changes' || !options.repositories) return undefined;
        const repo = options.repositories.find(
            (candidate) => candidate.id === diffTab.repositoryId,
        );
        if (!repo) return undefined;
        const absolutePath = resolveRepoFilePath(repo.rootPath, diffTab.path);
        return absolutePath
            ? {
                  absolutePath,
                  relativeRoot: relativePathRoot(absolutePath, options.projectRoot, repo.rootPath),
              }
            : undefined;
    }
    if (isVirtualEditorTabPath(path) || !options.projectRoot) return undefined;
    if (projectRelativePath(path, options.projectRoot) === undefined) return undefined;
    // No wait for the Git overview: the root never depends on it for an ordinary file, and the Files tree row for the
    // same file does not wait either.
    return { absolutePath: path, relativeRoot: options.projectRoot };
}
