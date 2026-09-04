import type { FileEntry } from '@caxri/protocol';
import { collectTreeSubtree, pathBasename } from '@caxri/utils';

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
    scopeId: string,
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
            parameters.contextKey !== scopeId ||
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
                (entry as { kind?: unknown }).kind === 'directory' &&
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
 * A symlink row states where it points and why it is inert, because its icon can otherwise be mistaken for the real
 * folder or file it mirrors. Every other row shows its path plus the Git-ignored qualifier.
 */
export function fileTreeRowTooltip(
    entry: Pick<FileEntry, 'gitIgnored' | 'kind' | 'linkKind' | 'linkTarget' | 'path'>,
): string {
    if (entry.kind !== 'symlink')
        return entry.gitIgnored ? `${entry.path} (Git ignored)` : entry.path;
    const target = entry.linkTarget === undefined ? '' : ` → ${entry.linkTarget}`;
    const linkKind = entry.linkKind === 'broken' ? 'broken symlink' : 'symlink';
    return `${entry.path}${target} (${linkKind}; browsing and changes are disabled for safety)`;
}

/**
 * The screen-reader description of a symlink row. It carries the same facts the tooltip gives a sighted mouse user —
 * where the link points and whether it resolves — minus the path already announced as the row's own name.
 */
export function symlinkRowDescription(entry: Pick<FileEntry, 'linkKind' | 'linkTarget'>): string {
    const target = entry.linkTarget === undefined ? '' : ` to ${entry.linkTarget}`;
    const unresolved = entry.linkKind === 'broken' ? ', which does not resolve' : '';
    return `Symlink${target}${unresolved}. Browsing and changes are disabled for safety.`;
}

/**
 * A filesystem root has no useful basename, so the panel caption stays blank instead of echoing separators.
 */
export function fileTreeRootCaption(rootPath: string): string {
    return /^[\\/]*$/.test(rootPath) ? '' : pathBasename(rootPath);
}
