import type { SourceControlGroup, SourceControlResource, SourceControlViewModel } from 'caxri';
import { l10n } from 'caxri';

/**
 * Leaves headroom below the Extension Host's 4 MiB response ceiling for the request envelope and serialization
 * differences. Git owns the truncation copy and projection; the generic transport remains a hard safety fence.
 */
const MAX_GIT_SOURCE_CONTROL_VIEW_BYTES = 3 * 1024 * 1024;
const PAYLOAD_RESERVE_BYTES = 64 * 1024;
const encoder = new TextEncoder();

function byteLength(value: unknown): number {
    return encoder.encode(JSON.stringify(value)).byteLength;
}

interface GroupCursor {
    source: SourceControlGroup;
    target: SourceControlGroup;
    offset: number;
}

function transportTruncationMessage(visible: number, total: number): string {
    return l10n.t('Showing the first {shown} of {total} changes', { shown: visible, total });
}

function emptyBoundedModel(model: SourceControlViewModel): {
    cursors: GroupCursor[];
    model: SourceControlViewModel;
} {
    const cursors: GroupCursor[] = [];
    const bounded: SourceControlViewModel = {
        ...model,
        truncationMessage: l10n.t(
            'Some Source Control resources are hidden because this workspace exceeds the display limit.',
        ),
        providers: model.providers.map((provider) => ({
            ...provider,
            groups: provider.groups.map((group) => {
                const target: SourceControlGroup = {
                    ...group,
                    ...(group.resources.length > 0 && {
                        truncationMessage: transportTruncationMessage(0, group.count),
                    }),
                    resources: [],
                };
                cursors.push({ source: group, target, offset: 0 });
                return target;
            }),
        })),
    };
    return { cursors, model: bounded };
}

function finalizeGroupMessages(cursors: readonly GroupCursor[]): void {
    for (const { source, target } of cursors)
        if (target.resources.length === source.resources.length) {
            if (source.truncationMessage) target.truncationMessage = source.truncationMessage;
            else delete target.truncationMessage;
        } else
            target.truncationMessage = transportTruncationMessage(
                target.resources.length,
                Math.max(source.count, source.resources.length),
            );
}

function popLastResource(cursors: readonly GroupCursor[]): SourceControlResource | undefined {
    for (let index = cursors.length - 1; index >= 0; index -= 1) {
        const cursor = cursors[index];
        const resource = cursor.target.resources.pop();
        if (resource) {
            cursor.offset -= 1;
            return resource;
        }
    }
}

function appendNextResource(cursor: GroupCursor, availableBytes: number): number {
    if (cursor.offset >= cursor.source.resources.length) return 0;
    const resource = cursor.source.resources[cursor.offset];
    const resourceBytes = byteLength(resource) + 1;
    if (resourceBytes > availableBytes) return 0;
    cursor.target.resources.push(resource);
    cursor.offset += 1;
    return resourceBytes;
}

/**
 * Fairly allocates the payload budget across repository groups instead of allowing the first repository to crowd out
 * every later provider. Resource order within each group remains stable.
 */
export function boundSourceControlViewModel(model: SourceControlViewModel): SourceControlViewModel {
    if (byteLength(model) <= MAX_GIT_SOURCE_CONTROL_VIEW_BYTES) return model;
    const bounded = emptyBoundedModel(model);
    let estimatedBytes = byteLength(bounded.model);
    const targetBytes = MAX_GIT_SOURCE_CONTROL_VIEW_BYTES - PAYLOAD_RESERVE_BYTES;
    let isMadeProgress = true;
    while (isMadeProgress) {
        isMadeProgress = false;
        for (const cursor of bounded.cursors) {
            const resourceBytes = appendNextResource(cursor, targetBytes - estimatedBytes);
            if (resourceBytes > 0) {
                estimatedBytes += resourceBytes;
                isMadeProgress = true;
            }
        }
    }
    finalizeGroupMessages(bounded.cursors);
    while (byteLength(bounded.model) > MAX_GIT_SOURCE_CONTROL_VIEW_BYTES) {
        if (!popLastResource(bounded.cursors)) {
            bounded.model.providers.pop();
            if (bounded.model.providers.length === 0) break;
        }
        finalizeGroupMessages(bounded.cursors);
    }
    return bounded.model;
}
