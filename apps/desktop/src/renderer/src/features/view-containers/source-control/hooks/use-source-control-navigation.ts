import { useCallback, useEffect, useRef, useState } from 'react';

import type { SourceControlViewState } from '@caxri/protocol';
import { MAX_SOURCE_CONTROL_VIEW_STATES } from '@caxri/protocol';

import { translate } from '../../../../i18n';
import { getBootstrap } from '../../../../stores/selectors';
import { patchSessionState } from '../../../../stores/workbench';
import type { SourceControlViewNavigation } from '../source-control-state';
import {
    createSourceControlViewNavigation,
    serializeSourceControlViewNavigation,
    updateSourceControlViewNavigation,
} from '../source-control-state';

export interface SourceControlNavigationScope {
    sessionId: string;
    viewId: string;
    workbenchRootProjectId: string;
}

function persistSourceControlNavigation(
    scope: SourceControlNavigationScope,
    navigation: SourceControlViewNavigation,
): void {
    const current = getBootstrap()?.sessionStates.find(
        (candidate) =>
            candidate.sessionId === scope.sessionId &&
            candidate.workbenchRootProjectId === scope.workbenchRootProjectId,
    );
    if (!current) return;
    const persisted = serializeSourceControlViewNavigation(navigation);
    if (
        JSON.stringify(current.sourceControlViewStates?.[scope.viewId]) ===
        JSON.stringify(persisted)
    )
        return;
    const retained = Object.entries(current.sourceControlViewStates ?? {})
        .filter(([viewId]) => viewId !== scope.viewId)
        .slice(-(MAX_SOURCE_CONTROL_VIEW_STATES - 1));
    patchSessionState(
        {
            ...current,
            sourceControlViewStates: {
                ...Object.fromEntries(retained),
                [scope.viewId]: persisted,
            },
        },
        translate('viewContainers.sourceControl.stateSaveFailed'),
    );
}

/**
 * Keeps Source Control navigation in the Session snapshot because switching ViewContainer tabs intentionally unmounts
 * inactive controllers. Flushing during cleanup preserves a last-second disclosure click before the tab disappears.
 */
export function useSourceControlNavigation(
    scope: SourceControlNavigationScope | undefined,
    persisted?: SourceControlViewState,
): [SourceControlViewNavigation, (patch: Partial<SourceControlViewNavigation>) => void] {
    const [navigation, setNavigation] = useState(() =>
        createSourceControlViewNavigation(persisted),
    );
    const latest = useRef(navigation);
    const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
    const persist = useCallback(
        (state: SourceControlViewNavigation): void => {
            if (scope) persistSourceControlNavigation(scope, state);
        },
        [scope],
    );
    const update = useCallback(
        (patch: Partial<SourceControlViewNavigation>): void => {
            const next = updateSourceControlViewNavigation(latest.current, patch);
            latest.current = next;
            setNavigation(next);
            if (pending.current) clearTimeout(pending.current);
            pending.current = setTimeout(() => {
                pending.current = undefined;
                persist(latest.current);
            }, 100);
        },
        [persist],
    );

    useEffect(
        () => () => {
            if (!pending.current) return;
            clearTimeout(pending.current);
            pending.current = undefined;
            persist(latest.current);
        },
        [persist],
    );

    return [navigation, update];
}
