import type { SourceControlViewModel } from '@caxri/protocol';

export type SourceControlPanelState =
    | { status: 'no-session' }
    | { status: 'loading' }
    | { status: 'no-repository' }
    | { status: 'unavailable'; message: string }
    | { status: 'ready' };

/**
 * Keeps missing context, pending data, absent repositories, and Git failures distinct across the panel.
 */
export function resolveSourceControlPanelState({
    hasSession,
    hasSnapshotError,
    model,
}: {
    hasSession: boolean;
    hasSnapshotError: boolean;
    model?: Pick<SourceControlViewModel, 'emptyKind' | 'emptyMessage'>;
}): SourceControlPanelState {
    if (!hasSession) return { status: 'no-session' };
    if (hasSnapshotError)
        return { status: 'unavailable', message: 'Source Control is unavailable right now.' };
    if (!model) return { status: 'loading' };
    if (model.emptyKind === 'no-repository') return { status: 'no-repository' };
    if (model.emptyMessage) return { status: 'unavailable', message: model.emptyMessage };
    return { status: 'ready' };
}
