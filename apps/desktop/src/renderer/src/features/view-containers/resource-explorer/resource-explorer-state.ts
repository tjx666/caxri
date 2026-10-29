import type { FileEntry, PaneTab } from '@caxri/protocol';
import { collectTreeSubtree, pathBasename } from '@caxri/utils';

import type { Translate } from '../../../i18n';
import { isDirectoryEntry } from '../../../lib/file-entry';
import type { GitChildRepoKind, GitDecoration } from '../../../lib/git-decorations';
import { gitChildRepoDescription, gitDecorationDescription } from '../../../lib/git-decorations';
import type { PendingFileOperation } from './file-operation-state';

interface FileListQuerySnapshot {
    data: unknown;
    isInvalidated: boolean;
    queryKey: readonly unknown[];
}

export function scopedValue<T>(
    values: Readonly<Record<string, T>>,
    scopeId: string,
): T | undefined {
    return values[scopeId];
}

export function setScopedValue<T>(
    values: Readonly<Record<string, T>>,
    scopeId: string,
    value: NoInfer<T>,
): Record<string, T> {
    return { ...values, [scopeId]: value };
}

export function setScopedPathExpanded(
    expandedByScope: Readonly<Record<string, string[]>>,
    scopeId: string,
    path: string,
    isNextExpanded: boolean | ((isCurrentExpanded: boolean) => boolean),
): Record<string, string[]> {
    const paths = new Set(expandedByScope[scopeId]);
    const isExpanded =
        typeof isNextExpanded === 'function' ? isNextExpanded(paths.has(path)) : isNextExpanded;
    if (isExpanded) paths.add(path);
    else paths.delete(path);
    return { ...expandedByScope, [scopeId]: [...paths] };
}

export function setScopedSubtreeExpanded(
    expandedByScope: Readonly<Record<string, string[]>>,
    scopeId: string,
    rootPath: string,
    knownChildren: ReadonlyMap<string, readonly string[]>,
    isExpanded: boolean,
): Record<string, string[]> {
    const paths = new Set(expandedByScope[scopeId]);
    const subtree = collectTreeSubtree(rootPath, (path) => knownChildren.get(path) ?? []);
    for (const path of subtree) {
        if (isExpanded && path !== rootPath && !knownChildren.has(path)) continue;
        if (isExpanded) paths.add(path);
        else paths.delete(path);
    }
    return { ...expandedByScope, [scopeId]: [...paths] };
}

/**
 * Builds the loaded directory graph from React Query's current cache instead of retaining a second tree cache.
 * Invalidated results are stale by definition and must not make recursive expansion visit removed paths.
 */
export function knownDirectoryChildrenFromQueries(
    queries: readonly FileListQuerySnapshot[],
    viewId: string,
    contextKey: string,
): Map<string, readonly string[]> {
    const knownChildren = new Map<string, readonly string[]>();
    for (const query of queries) {
        if (query.isInvalidated) continue;
        const [method, rawParameters] = query.queryKey;
        if (
            method !== 'viewContainers.viewOperation' ||
            typeof rawParameters !== 'object' ||
            rawParameters === null
        )
            continue;
        const parameters = rawParameters as {
            arguments?: unknown;
            contextKey?: unknown;
            operation?: unknown;
            viewId?: unknown;
        };
        if (
            parameters.viewId !== viewId ||
            parameters.operation !== 'files.list' ||
            parameters.contextKey !== contextKey ||
            typeof parameters.arguments !== 'object' ||
            parameters.arguments === null
        )
            continue;
        const directory = (parameters.arguments as { directory?: unknown }).directory;
        if (typeof directory !== 'string' || typeof query.data !== 'object' || query.data === null)
            continue;
        const entries = (query.data as { entries?: unknown }).entries;
        if (!Array.isArray(entries)) continue;
        knownChildren.set(
            directory,
            entries.flatMap((entry) =>
                typeof entry === 'object' &&
                entry !== null &&
                isDirectoryEntry(entry as FileEntry) &&
                typeof (entry as { path?: unknown }).path === 'string'
                    ? [(entry as { path: string }).path]
                    : [],
            ),
        );
    }
    return knownChildren;
}

export function fileOperationsForProject(
    operations: readonly PendingFileOperation[],
    projectId: string | undefined,
): PendingFileOperation[] {
    return operations.filter((operation) => operation.projectId === projectId);
}

/**
 * An expanded symlink with missing metadata can only come from an active-file ancestor reveal; manual activation probes
 * its kind first. Expansion stays a UI hint: listing that path remains Server-authorized, so a replaced link fails
 * closed there.
 */
export function isFileTreeDirectory(
    entry: Pick<FileEntry, 'kind' | 'linkKind'>,
    resolvedKind: 'file' | 'directory' | undefined,
    isExpanded: boolean,
): boolean {
    if (entry.kind !== 'symlink') return isDirectoryEntry(entry);
    if (resolvedKind !== undefined) return resolvedKind === 'directory';
    return isDirectoryEntry(entry) || (entry.linkKind === undefined && isExpanded);
}

/**
 * A symlink row states where it points and why it is inert, because its icon can otherwise be mistaken for the real
 * folder or file it mirrors. Every other row shows its path plus whichever qualifiers apply.
 *
 * `nested` and `submodule` are worth telling apart here: only the submodule is recorded by the parent, so only it will
 * show up as a change there when its commit moves.
 *
 * @param entry The row the tooltip describes.
 * @param childRepo Set when the directory is a repository of its own, which the icon shows but does not name.
 * @param t The caller's `useTranslation()` function.
 */
export function fileTreeRowTooltip(
    entry: Pick<FileEntry, 'gitIgnored' | 'kind' | 'linkKind' | 'linkTarget' | 'path'>,
    childRepo: GitChildRepoKind | undefined,
    t: Translate,
): string {
    if (entry.kind !== 'symlink') {
        const qualifiers = [
            childRepo === 'submodule' ? t('viewContainers.files.row.gitSubmodule') : undefined,
            childRepo === 'nested' ? t('viewContainers.files.row.nestedRepository') : undefined,
            entry.gitIgnored ? t('viewContainers.files.row.gitIgnored') : undefined,
        ].filter(Boolean);
        return qualifiers.length === 0 ? entry.path : `${entry.path} (${qualifiers.join(', ')})`;
    }
    const target = entry.linkTarget === undefined ? '' : ` → ${entry.linkTarget}`;
    const linkKind = t(
        entry.linkKind === 'broken'
            ? 'viewContainers.files.row.brokenSymlink'
            : 'viewContainers.files.row.symlink',
    );
    return `${entry.path}${target} (${linkKind})`;
}

/**
 * The screen-reader description of a symlink row. It carries the same facts the tooltip gives a sighted mouse user:
 * where the link points and whether it resolves, minus the path already announced as the row's own name.
 */
export function symlinkRowDescription(
    entry: Pick<FileEntry, 'linkKind' | 'linkTarget'>,
    t: Translate,
): string {
    const isBroken = entry.linkKind === 'broken';
    if (entry.linkTarget === undefined)
        return t(
            isBroken
                ? 'viewContainers.files.row.symlinkBrokenDescription'
                : 'viewContainers.files.row.symlinkDescription',
        );
    return t(
        isBroken
            ? 'viewContainers.files.row.symlinkBrokenTargetDescription'
            : 'viewContainers.files.row.symlinkTargetDescription',
        {
            target: entry.linkTarget,
        },
    );
}

/**
 * Everything the row shows that its own name cannot carry, joined into one `aria-describedby` string. The name stays
 * the bare file name: it is what the user typed to find the row and what every role query matches, so the
 * followable-symlink reason, the child-repository kind, and the Git change ride along here instead. Empty when the row
 * shows none of them, which is the common case.
 *
 * @param entry The row being described.
 * @param childRepo Set when the directory is a repository of its own, which only the folder icon shows.
 * @param decoration Set when Git reports the path as changed, which only the row's color and status letter show.
 */
export function fileTreeRowDescription(
    entry: Pick<FileEntry, 'kind' | 'linkKind' | 'linkTarget'>,
    childRepo: GitChildRepoKind | undefined,
    decoration: GitDecoration | undefined,
    t: Translate,
): string {
    return [
        entry.kind === 'symlink' ? symlinkRowDescription(entry, t) : undefined,
        childRepo ? gitChildRepoDescription(childRepo, t) : undefined,
        decoration ? gitDecorationDescription(decoration.kind, t) : undefined,
    ]
        .filter(Boolean)
        .join(' ');
}

/**
 * A filesystem root has no useful basename, so the panel caption stays blank instead of echoing separators.
 */
export function fileTreeRootCaption(rootPath: string): string {
    return /^[\\/]*$/.test(rootPath) ? '' : pathBasename(rootPath);
}

/**
 * The file a work tab shows, when it shows a file at all: the path the Files tree follows.
 */
export function paneTabFilePath(tab: PaneTab | undefined): string | undefined {
    return tab?.resource.kind === 'file' ? tab.resource.path : undefined;
}
