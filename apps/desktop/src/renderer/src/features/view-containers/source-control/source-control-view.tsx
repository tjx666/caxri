import { useMemo } from 'react';

import type { SourceControlViewState } from '@caxri/protocol';

import { useSessionViewScope, useSourceControlViewState } from '../../../stores/selectors';
import { useControlledView } from '../controlled-view-context';
import { useHeldWhileHidden } from '../view-container-activity';
import { useSourceControlController } from './hooks/use-source-control-controller';
import type { SourceControlNavigationScope } from './hooks/use-source-control-navigation';
import { SourceControlContent } from './source-control-content';

/**
 * Uses a scope key so switching Session or Workbench Root initializes from that snapshot without briefly showing the
 * previous root's disclosure state.
 *
 * A hidden keep-alive container holds the scope it last showed instead of following every Session switch: re-keying
 * there remounted the whole hidden view (about a hundred components) per switch for nothing on screen. Revealing the
 * container adopts the current scope during render, so the stale scope never paints.
 */
export function SourceControlView() {
    const { viewId } = useControlledView();
    const { sessionId, workbenchProjectId } = useHeldWhileHidden(
        useSessionViewScope(),
        isSameSessionViewScope,
    );
    const persisted = useSourceControlViewState(viewId);
    const scope = useMemo<SourceControlNavigationScope | undefined>(
        () =>
            sessionId && workbenchProjectId
                ? {
                      sessionId,
                      viewId,
                      workbenchProjectId,
                  }
                : undefined,
        [sessionId, viewId, workbenchProjectId],
    );
    const scopeKey = scope
        ? `${scope.sessionId}\0${scope.workbenchProjectId}\0${scope.viewId}`
        : `empty\0${viewId}`;
    return <ScopedSourceControlView key={scopeKey} persisted={persisted} scope={scope} />;
}

function isSameSessionViewScope(
    left: { sessionId?: string; workbenchProjectId?: string },
    right: { sessionId?: string; workbenchProjectId?: string },
): boolean {
    return (
        left.sessionId === right.sessionId && left.workbenchProjectId === right.workbenchProjectId
    );
}

function ScopedSourceControlView({
    persisted,
    scope,
}: {
    persisted?: SourceControlViewState;
    scope?: SourceControlNavigationScope;
}) {
    const controller = useSourceControlController(scope, persisted);
    return <SourceControlContent controller={controller} />;
}
