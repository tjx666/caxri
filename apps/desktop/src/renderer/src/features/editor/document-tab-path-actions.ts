import type { GitRepositoryOverview } from '@caxri/protocol';
import { isVirtualEditorTabPath, parseExternalEditorTab, parseGitDiffTab } from '@caxri/protocol';

import { copyFilePath } from '../../lib/copy-file-path';
import { isPathAtOrBelow, projectRelativePath } from '../../lib/file-path';
import { resolveRepositoryFilePath as resolveRepoFilePath } from '../../lib/repository-file-path';

type RepoRoot = Pick<GitRepositoryOverview, 'id' | 'rootPath'>;

export interface DocumentTabPathResolution {
    absolutePath: string;
    relativeRoot?: string;
}

function repoForPath(path: string, repositories: readonly RepoRoot[]): RepoRoot | undefined {
    let match: RepoRoot | undefined;
    for (const repo of repositories) {
        if (
            isPathAtOrBelow(path, repo.rootPath) &&
            (!match || repo.rootPath.length > match.rootPath.length)
        )
            match = repo;
    }
    return match;
}

/**
 * Resolves a tab resource to a filesystem path and the repository root used for relative clipboard output.
 *
 * Ordinary editor paths are already absolute and must remain inside the authorized Workbench Project. Single-file Git
 * tabs carry repository-relative paths inside their virtual URI, so their absolute path is reconstructed only from the
 * Server-provided repository root. External documents use only the Main-authorized cached display path; their opaque
 * URI is not a filesystem path. Multi-file changes and transcripts have no one file to copy.
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
        return absolutePath ? { absolutePath, relativeRoot: repo.rootPath } : undefined;
    }
    if (isVirtualEditorTabPath(path) || !options.projectRoot) return undefined;
    if (projectRelativePath(path, options.projectRoot) === undefined) return undefined;
    const repo = options.repositories ? repoForPath(path, options.repositories) : undefined;
    return {
        absolutePath: path,
        // A loaded Git overview gives nested repositories and submodules their own relative root. When no repository
        // contains the file, preserve the existing Files menu behavior and use the authorized Project root.
        relativeRoot: options.repositories ? (repo?.rootPath ?? options.projectRoot) : undefined,
    };
}

/**
 * Reuses the Files action so path writes, relative-path validation, and success/error toasts stay identical across tree
 * rows and document tabs.
 */
export function copyDocumentTabPath(
    path: string,
    relativeRoot?: string,
): Promise<void | undefined> {
    return copyFilePath(path, relativeRoot);
}
