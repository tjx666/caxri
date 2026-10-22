import type { SourceControlViewModel } from '@caxri/protocol';

import { translate } from '../../../i18n';

export type SourceControlPanelState =
    | { status: 'no-session' }
    | { status: 'loading' }
    | { status: 'no-repository' }
    | { status: 'unavailable'; message: string }
    | { status: 'ready' };

/**
 * Keeps missing context, pending data, absent repositories, and Git failures distinct across the panel.
 *
 * A real refresh failure never leaves stale content on screen. A refresh that a newer request superseded
 * (`GENERATION_EXPIRED`, for example a Refresh click racing a watcher refresh) is not a failure: it keeps the previous
 * snapshot, because flashing the error page and back remounted the whole tree.
 */
export function resolveSourceControlPanelState({
    hasSession,
    hasSnapshotError,
    isSnapshotSuperseded = false,
    model,
}: {
    hasSession: boolean;
    hasSnapshotError: boolean;
    /**
     * The failed refetch was superseded by a newer request rather than failing.
     */
    isSnapshotSuperseded?: boolean;
    model?: Pick<SourceControlViewModel, 'emptyKind' | 'emptyMessage'>;
}): SourceControlPanelState {
    if (!hasSession) return { status: 'no-session' };
    if (hasSnapshotError && !(isSnapshotSuperseded && model))
        return {
            status: 'unavailable',
            message: translate('viewContainers.sourceControl.unavailable'),
        };
    if (!model) return { status: 'loading' };
    if (model.emptyKind === 'no-repository') return { status: 'no-repository' };
    if (model.emptyMessage) return { status: 'unavailable', message: model.emptyMessage };
    return { status: 'ready' };
}

/**
 * Whether a snapshot query error only means a newer request replaced it.
 */
export function isSupersededSnapshotError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'GENERATION_EXPIRED'
    );
}
