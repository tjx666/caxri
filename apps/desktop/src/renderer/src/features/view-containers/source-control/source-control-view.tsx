import { useMemo } from 'react';

import type { SourceControlViewState } from '@caxri/protocol';

import { useSessionState } from '../../../stores/selectors';
import { useControlledView } from '../controlled-view-context';
import { useSourceControlController } from './hooks/use-source-control-controller';
import type { SourceControlNavigationScope } from './hooks/use-source-control-navigation';
import { SourceControlContent } from './source-control-content';

/**
 * Uses a scope key so switching Session or Workbench Root initializes from that snapshot without briefly showing the
 * previous root's disclosure state.
 */
export function SourceControlView() {
    const { viewId } = useControlledView();
    const sessionState = useSessionState();
    const sessionId = sessionState?.sessionId;
    const workbenchProjectId = sessionState?.workbenchProjectId;
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
    return (
        <ScopedSourceControlView
            key={scopeKey}
            persisted={sessionState?.sourceControlViewStates?.[viewId]}
            scope={scope}
        />
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
