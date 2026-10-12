import type { GitRepositoryOverview, PaneTab } from '@caxri/protocol';
import {
    isExternalEditorTabPath,
    isVirtualEditorTabPath,
    parseExternalEditorTab,
    parseGitDiffTab,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { relativePathRoot } from '../../lib/copy-file-path';
import { projectRelativePath } from '../../lib/file-path';
import { resolveRepositoryFilePath as resolveRepoFilePath } from '../../lib/repository-file-path';

type RepoRoot = Pick<GitRepositoryOverview, 'id' | 'rootPath'>;

/**
 * The document whose actions fill the tab rail's action slot: a Project file, a Git diff, or an external document.
 * Other virtual tabs (Settings, previews, transcripts) carry no editor actions.
 */
export function editorTabActionsPath(tab: PaneTab | undefined): string | undefined {
    if (tab?.resource.kind !== 'file') return undefined;
    const { path } = tab.resource;
    if (!isVirtualEditorTabPath(path)) return path;
    return parseGitDiffTab(path) || isExternalEditorTabPath(path) ? path : undefined;
}

/**
 * Keeps virtual-resource capabilities and query feedback out of the tab's presentation branches.
 */
export function documentTabPathMenuState(
    path: string,
    query: { isError: boolean; isPending: boolean },
    t: Translate = translate,
): { externalDocumentId?: string; showMenu: boolean; unavailableReason: string } {
    const external = parseExternalEditorTab(path);
    const diff = parseGitDiffTab(path);
    return {
        ...(external && { externalDocumentId: external.documentId }),
        showMenu:
            !isVirtualEditorTabPath(path) ||
            Boolean(external) ||
            Boolean(diff && diff.kind !== 'changes'),
        unavailableReason: t(
            query.isError
                ? 'editor.pathMenu.repositoryLoadFailed'
                : query.isPending
                  ? 'editor.pathMenu.repositoryLoading'
                  : 'editor.pathMenu.pathUnavailable',
        ),
    };
}

export interface DocumentTabPathResolution {
    absolutePath: string;
    relativeRoot?: string;
}

/**
 * What the tab menu's desktop actions (Open with Default App, Reveal in Finder, Open in Terminal) hand to the operating
 * system: a Project path, which Server Core re-validates against the Session's Project root, or an external document's
 * opaque ID, which Main resolves to the file it read. An external document never takes the path route because it sits
 * outside every Project root and Server Core would refuse it.
 */
export type DocumentTabDesktopTarget =
    { kind: 'path'; path: string } | { kind: 'external'; documentId: string };

export function documentTabDesktopActionState(
    resolution: DocumentTabPathResolution | undefined,
    options: { externalDocumentId?: string; unavailableReason: string },
): { disabledReason?: string; target?: DocumentTabDesktopTarget } {
    if (options.externalDocumentId)
        return { target: { kind: 'external', documentId: options.externalDocumentId } };
    if (!resolution) return { disabledReason: options.unavailableReason };
    return { target: { kind: 'path', path: resolution.absolutePath } };
}

/**
 * Resolves a tab resource to a filesystem path and the root used for relative clipboard output.
 *
 * Ordinary editor paths are already absolute and must remain inside the authorized Workbench Project. Single-file Git
 * tabs carry repository-relative paths inside their virtual URI, so their absolute path is reconstructed only from the
 * Server-provided repository root. External documents use only the Main-authorized cached display path; their opaque
 * URI is not a filesystem path. Multi-file changes and transcripts have no one file to copy.
 *
 * A Git diff tab is the one case with two candidate roots, so it is the one that defers to `relativePathRoot`; an
 * ordinary tab, like a Files tree row, is under the Project root by construction and measures from it directly.
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
