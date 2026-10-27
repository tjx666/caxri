import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExtensionTreeViewState } from '@caxri/protocol';
import { MAX_EXTENSION_TREE_VIEW_STATES } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { getBootstrap } from '../../../stores/selectors';
import { patchSessionState } from '../../../stores/workbench';
import type { ExtensionTreeState } from '../extension-tree-state';
import { createExtensionTreeState, serializeExtensionTreeState } from '../extension-tree-state';

interface ExtensionTreeStateScope {
    sessionId: string;
    workbenchRootProjectId: string;
    viewId: string;
}

function persistTreeState(scope: ExtensionTreeStateScope, state: ExtensionTreeState): void {
    const current = getBootstrap()?.sessionStates.find(
        (candidate) =>
            candidate.sessionId === scope.sessionId &&
            candidate.workbenchRootProjectId === scope.workbenchRootProjectId,
    );
    if (!current) return;
    const persisted = serializeExtensionTreeState(state);
    if (
        JSON.stringify(current.extensionTreeViewStates?.[scope.viewId]) ===
        JSON.stringify(persisted)
    )
        return;
    const retained = Object.entries(current.extensionTreeViewStates ?? {})
        .filter(([viewId]) => viewId !== scope.viewId)
        .slice(-(MAX_EXTENSION_TREE_VIEW_STATES - 1));
    patchSessionState(
        {
            ...current,
            extensionTreeViewStates: {
                ...Object.fromEntries(retained),
                [scope.viewId]: persisted,
            },
        },
        translate('viewContainers.extensionTree.stateSaveFailed'),
    );
}

export function useExtensionTreeState(
    scope: ExtensionTreeStateScope,
    persisted?: ExtensionTreeViewState,
): [ExtensionTreeState, (update: (current: ExtensionTreeState) => ExtensionTreeState) => void] {
    const [state, setState] = useState(() => createExtensionTreeState(persisted));
    const latest = useRef(state);
    const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const update = useCallback(
        (apply: (current: ExtensionTreeState) => ExtensionTreeState): void => {
            const current = latest.current;
            const next = apply(current);
            if (next === current) return;
            latest.current = next;
            setState(next);
            if (pending.current) clearTimeout(pending.current);
            pending.current = setTimeout(() => {
                pending.current = undefined;
                persistTreeState(scope, latest.current);
            }, 100);
        },
        [scope],
    );

    useEffect(
        () => () => {
            if (!pending.current) return;
            clearTimeout(pending.current);
            pending.current = undefined;
            persistTreeState(scope, latest.current);
        },
        [scope],
    );

    return [state, update];
}
