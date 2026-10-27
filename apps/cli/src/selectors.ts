import { CaxriError } from '@caxri/protocol';

export interface SelectableRecord {
    title: string;
    id: string;
    projectId?: string;
}

export function resolveSelector<T extends SelectableRecord>(
    records: readonly T[],
    selector: string,
    options: { currentId?: string; kind: string; projectId?: string },
): T {
    const scoped = options.projectId
        ? records.filter((record) => record.projectId === options.projectId)
        : [...records];
    const resolvedSelector = selector === 'current' ? options.currentId : selector;
    if (!resolvedSelector)
        throw new CaxriError('NOT_FOUND', `No current ${options.kind} is available`);
    const byId = scoped.find((record) => record.id === resolvedSelector);
    if (byId) return byId;
    const matches = scoped.filter((record) => record.title === resolvedSelector);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1)
        throw new CaxriError('CONFLICT', `${options.kind} selector is ambiguous`, {
            candidates: matches.slice(0, 32).map(({ id, title, projectId }) => ({
                id,
                title,
                ...(projectId && { projectId }),
            })),
        });
    throw new CaxriError('NOT_FOUND', `${options.kind} selector did not match`);
}
