import { pathBasename } from '@caxri/utils';

import type { PendingFileOperation } from './file-operation-state';

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

export function fileOperationsForProject(
    operations: readonly PendingFileOperation[],
    projectId: string | undefined,
): PendingFileOperation[] {
    return operations.filter((operation) => operation.projectId === projectId);
}

/**
 * A filesystem root has no useful basename, so the panel caption stays blank instead of echoing separators.
 */
export function fileTreeRootCaption(rootPath: string): string {
    return /^[\\/]*$/.test(rootPath) ? '' : pathBasename(rootPath);
}
