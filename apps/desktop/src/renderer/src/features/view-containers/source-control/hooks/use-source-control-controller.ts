import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
    PaneResource,
    SourceControlAction,
    SourceControlActionEffect,
    SourceControlViewModel,
    SourceControlViewState,
} from '@caxri/protocol';
import { isCaxriError, isVirtualEditorTabPath } from '@caxri/protocol';
import { queryOptions, useQuery } from '@tanstack/react-query';

import {
    executeViewCatalogShortcut,
    invalidateControlledViewSnapshot,
} from '../../../../features/view-containers/view-container-commands';
import { useOnVisible } from '../../../../hooks/use-on-visible';
import type { Translate } from '../../../../i18n';
import { useTranslation } from '../../../../i18n';
import { useToastOnQueryError } from '../../../../queries/client';
import { useSessionViewScope, useSettings } from '../../../../stores/selectors';
import { pushToast, tryCommand } from '../../../../stores/toasts';
import { openEditorTab } from '../../../editor/document-commands';
import { useControlledView, useSourceControlClient } from '../../controlled-view-context';
import {
    isViewContainerQueryEnabled,
    useCancelViewContainerQueryWhenHidden,
    useIsViewContainerActive,
} from '../../view-container-activity';
import { subscribeViewEvents } from '../../view-event-bridge';
import type { SourceControlClient } from '../../view-operation-client';
import { controlledViewQueryKey } from '../../view-operation-client';
import {
    runSourceControlActionAgainstLatest,
    SUPERSEDED,
} from '../source-control-action-resolution';
import { refreshingActionMessage } from '../source-control-history-state';
import { localizeActionEffect, localizeSourceControlModel } from '../source-control-model-text';
import type { SourceControlPanelState } from '../source-control-panel-state';
import {
    isSupersededSnapshotError,
    resolveSourceControlPanelState,
} from '../source-control-panel-state';
import type { SourceControlViewNavigation } from '../source-control-state';
import { setSourceControlDisclosuresExpanded } from '../source-control-state';
import { useHeldActiveFilePath } from './use-held-active-file-path';
import type { SourceControlNavigationScope } from './use-source-control-navigation';
import { useSourceControlNavigation } from './use-source-control-navigation';

type SourceControlMode = SourceControlViewModel['modes'][number];

function applyActionEffect(effect: SourceControlActionEffect, t: Translate): void {
    const localized = localizeActionEffect(effect, t);
    if (localized.kind === 'open-editor') openEditorTab(localized.resource);
    else pushToast(localized.tone, localized.message);
}

type SourceControlViewEmptyController = Exclude<SourceControlPanelState, { status: 'ready' }> & {
    isRefreshing: boolean;
    loadingMessage: string;
    noContextMessage: string;
    refresh: () => void;
};

/**
 * One recursive disclosure gesture, whose rows live in three separate persisted maps. It travels as one target so the
 * repository, its groups, and their directories change together instead of through three renders, any of which a
 * background refresh could land between.
 */
export interface SourceControlSubtreeTarget {
    directoryKeys: readonly string[];
    groupIds: readonly string[];
    providerId?: string;
}

interface SourceControlViewReadyController {
    activeEditorResource: string | undefined;
    fileHistoryExpanded: boolean;
    isRefreshing: boolean;
    model: SourceControlViewModel;
    navigation: SourceControlViewNavigation;
    runAction: (action: SourceControlAction) => Promise<void>;
    selectMode: (mode: SourceControlMode) => void;
    setDirectoriesExpanded: (keys: readonly string[], isExpanded: boolean) => void;
    setFileHistoryExpanded: Dispatch<SetStateAction<boolean>>;
    setGroupExpanded: (groupId: string, isExpanded: boolean) => void;
    setProviderExpanded: (providerId: string, isExpanded: boolean) => void;
    setSubtreeExpanded: (target: SourceControlSubtreeTarget, isExpanded: boolean) => void;
    status: 'ready';
}

export type SourceControlController =
    SourceControlViewEmptyController | SourceControlViewReadyController;

type SourceControlSnapshotRequest = Record<string, unknown> & {
    activeResource?: string;
    preferredModeId?: string;
};

interface SourceControlSnapshotIdentity {
    activeResource: string | undefined;
    preferredModeId: string | undefined;
}

function requestedSnapshotIdentityFromQueryKey(
    queryKey: readonly unknown[],
): SourceControlSnapshotIdentity | undefined {
    const parameters = queryKey[1];
    if (typeof parameters !== 'object' || parameters === null) return;
    const arguments_ = (parameters as { arguments?: unknown }).arguments;
    if (typeof arguments_ !== 'object' || arguments_ === null) return;
    const { activeResource, preferredModeId } = arguments_ as {
        activeResource?: unknown;
        preferredModeId?: unknown;
    };
    return {
        activeResource: typeof activeResource === 'string' ? activeResource : undefined,
        preferredModeId: typeof preferredModeId === 'string' ? preferredModeId : undefined,
    };
}

export function buildSourceControlSnapshotRequest(
    activeResource: PaneResource | undefined,
    preferredModeId: string | undefined,
): SourceControlSnapshotRequest {
    return {
        ...(preferredModeId && { preferredModeId }),
        ...(activeResource?.kind === 'file' &&
            !isVirtualEditorTabPath(activeResource.path) && {
                activeResource: activeResource.path,
            }),
    };
}

/**
 * Keeps the last resolved model mounted during refresh and mode navigation. Its own mode selection and labels stay
 * together until the replacement arrives, and fetching blocks revision-bound actions. Active-file changes receive no
 * placeholder so file-specific content never crosses that boundary.
 *
 * `refresh` is a Server nonce, not cache identity: putting it in the query key made a re-mount with `refresh: 0` miss
 * the last `refresh:N` snapshot and flash the loading empty state. Forced refreshes pass the nonce into `queryFn` and
 * invalidate the same key so a hidden `enabled: false` observer does not fetch.
 *
 * Session and Workbench Root changes remount `ScopedSourceControlView` with a new scope key, so placeholder data never
 * crosses those ownership boundaries.
 */
export function sourceControlSnapshotQueryOptions({
    client,
    configRevision,
    enabled,
    queryScope,
    refresh = 0,
    request,
    viewId,
}: {
    client: Pick<SourceControlClient, 'snapshot'>;
    configRevision: string;
    enabled: boolean;
    queryScope?: string;
    refresh?: number;
    request: SourceControlSnapshotRequest;
    viewId: string;
}) {
    return queryOptions({
        queryKey: controlledViewQueryKey(
            viewId,
            'source.snapshot',
            request,
            queryScope,
            configRevision,
        ),
        queryFn: ({ signal }) => client.snapshot({ ...request, refresh }, signal),
        enabled,
        /**
         * Revision-bound actions and history pages make cached snapshots unsafe after another file advances the model.
         */
        staleTime: 0,
        placeholderData: (previousData, previousQuery) => {
            const previousRequest = requestedSnapshotIdentityFromQueryKey(
                previousQuery?.queryKey ?? [],
            );
            if (!previousRequest) return;
            return previousRequest.activeResource === request.activeResource
                ? previousData
                : undefined;
        },
    });
}

/**
 * Owns generic provider-model fetching, scoped disclosure state, and action effects.
 */
export function useSourceControlController(
    navigationScope?: SourceControlNavigationScope,
    persistedNavigation?: SourceControlViewState,
): SourceControlController {
    const { t } = useTranslation();
    const { configurationDependencies, presentation, providerGeneration, viewId } =
        useControlledView();
    const client = useSourceControlClient();
    const { sessionId, workbenchProjectId } = useSessionViewScope();
    const hasSession = sessionId !== undefined && workbenchProjectId !== undefined;
    const settings = useSettings();
    const isContainerActive = useIsViewContainerActive();
    /**
     * The active file is part of the snapshot key. A hidden view keeps the file it last showed: following every
     * work-tab switch moved its disabled query to an empty key, dropped the panel to `loading`, and remounted the whole
     * tree.
     */
    const activeFilePath = useHeldActiveFilePath();
    /**
     * Prefer the view's held scope: a Session switch while the view is hidden must not move the disabled query to a new
     * key either, for the same remount reason as the active file above.
     */
    const queryScope = navigationScope
        ? `${navigationScope.sessionId}:${navigationScope.workbenchProjectId}`
        : hasSession
          ? `${sessionId}:${workbenchProjectId}`
          : undefined;
    const [fileHistoryExpanded, setFileHistoryExpanded] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const [navigation, updateNavigation] = useSourceControlNavigation(
        navigationScope,
        persistedNavigation,
    );
    const snapshotRequest = buildSourceControlSnapshotRequest(
        activeFilePath === undefined ? undefined : { kind: 'file', path: activeFilePath },
        navigation.modeId,
    );
    const configRevision = JSON.stringify(
        configurationDependencies.map((key) => [
            key,
            (settings as Readonly<Record<string, unknown>> | undefined)?.[key],
        ]),
    );
    const snapshotOptions = sourceControlSnapshotQueryOptions({
        client,
        configRevision,
        enabled: isViewContainerQueryEnabled(isContainerActive, hasSession),
        queryScope,
        refresh,
        request: snapshotRequest,
        viewId,
    });
    useCancelViewContainerQueryWhenHidden(snapshotOptions.queryKey, isContainerActive);
    const snapshot = useQuery(snapshotOptions);
    /**
     * The Git extension sends English; translate for display only. Action resolution keeps using `snapshot.data`, which
     * matches by command binding and never by label.
     */
    const localizedModel = useMemo(
        () => (snapshot.data ? localizeSourceControlModel(snapshot.data, t) : undefined),
        [snapshot.data, t],
    );
    const requestRefresh = useCallback(() => {
        setRefresh((current) => current + 1);
    }, []);
    /**
     * The Git provider asks for a re-read after every watcher burst. While the window is hidden nobody sees the panel,
     * so those requests collapse into one re-read when it shows again instead of a snapshot read per Agent write.
     */
    const hasHiddenRefreshReference = useRef(false);
    useOnVisible(() => {
        if (!hasHiddenRefreshReference.current) return;
        hasHiddenRefreshReference.current = false;
        requestRefresh();
    });
    useEffect(() => {
        if (refresh === 0) return;
        void invalidateControlledViewSnapshot(viewId);
    }, [refresh, viewId]);
    useToastOnQueryError(
        snapshot.isError,
        snapshot.error,
        presentation?.refreshErrorMessage ?? t('viewContainers.sourceControl.refreshFailed'),
    );
    useEffect(() => {
        // A transition placeholder still names the old mode, not a provider fallback for the new request.
        if (snapshot.isPlaceholderData) return;
        const selectedModeId = snapshot.data?.selectedModeId;
        if (selectedModeId && selectedModeId !== navigation.modeId)
            updateNavigation({ modeId: selectedModeId });
    }, [
        navigation.modeId,
        snapshot.data?.selectedModeId,
        snapshot.isPlaceholderData,
        updateNavigation,
    ]);
    useEffect(
        () =>
            sessionId === undefined || workbenchProjectId === undefined
                ? () => {}
                : subscribeViewEvents(
                      {
                          viewId,
                          sessionId,
                          workbenchProjectId,
                          extensionGeneration: providerGeneration,
                      },
                      (event) => {
                          if (event.payload.change.kind === 'refresh') {
                              if (document.visibilityState === 'hidden')
                                  hasHiddenRefreshReference.current = true;
                              else requestRefresh();
                          } else if (event.payload.change.kind === 'selection')
                              updateNavigation({
                                  modeId: event.payload.change.selectedModeId,
                              });
                      },
                  ),
        [
            providerGeneration,
            requestRefresh,
            sessionId,
            updateNavigation,
            viewId,
            workbenchProjectId,
        ],
    );
    const refetchSnapshot = snapshot.refetch;
    const runAction = useCallback(
        async (action: SourceControlAction): Promise<void> => {
            if (action.disabled || !snapshot.data) return;
            const label =
                action.errorMessage ??
                presentation?.actionErrorMessage ??
                t('viewContainers.sourceControl.actionFailed');
            const run = (target: SourceControlAction, revision: string) =>
                tryCommand(label, async () => {
                    try {
                        return await client.action({ actionId: target.id, revision });
                    } catch (error) {
                        if (isCaxriError(error) && error.code === 'CONFLICT') return SUPERSEDED;
                        throw error;
                    }
                });
            const outcome = await runSourceControlActionAgainstLatest({
                action,
                isRefreshing: snapshot.isFetching,
                model: snapshot.data,
                refetch: async () => (await refetchSnapshot({ cancelRefetch: false })).data,
                run,
            });
            if (outcome === SUPERSEDED) {
                pushToast('warning', refreshingActionMessage());
                return;
            }
            const { result, revision } = outcome;
            if (!result || result.revision !== revision) return;
            for (const effect of result.effects) applyActionEffect(effect, t);
            if (result.refresh) requestRefresh();
        },
        [
            client,
            presentation?.actionErrorMessage,
            requestRefresh,
            snapshot.data,
            snapshot.isFetching,
            refetchSnapshot,
            t,
        ],
    );
    const selectMode = useCallback(
        (mode: SourceControlMode): void => {
            updateNavigation({ modeId: mode.id });
            void executeViewCatalogShortcut(mode.command.id, mode.command.arguments ?? []);
        },
        [updateNavigation],
    );
    const panelState = resolveSourceControlPanelState({
        hasSession,
        hasSnapshotError: snapshot.isError,
        isSnapshotSuperseded: isSupersededSnapshotError(snapshot.error),
        model: localizedModel,
    });
    if (panelState.status !== 'ready')
        return {
            ...panelState,
            isRefreshing: snapshot.isFetching,
            loadingMessage:
                presentation?.loadingMessage ?? t('viewContainers.sourceControl.loading'),
            noContextMessage:
                presentation?.noContextMessage ?? t('viewContainers.sourceControl.noSessionHint'),
            refresh: requestRefresh,
        };
    if (!localizedModel)
        return {
            status: 'loading',
            isRefreshing: true,
            loadingMessage:
                presentation?.loadingMessage ?? t('viewContainers.sourceControl.loading'),
            noContextMessage:
                presentation?.noContextMessage ?? t('viewContainers.sourceControl.noSessionHint'),
            refresh: requestRefresh,
        };

    return {
        activeEditorResource: activeFilePath,
        fileHistoryExpanded,
        isRefreshing: snapshot.isFetching,
        model: localizedModel,
        navigation,
        runAction,
        selectMode,
        setDirectoriesExpanded: (keys, isExpanded) =>
            updateNavigation({
                expandedDirectories: setSourceControlDisclosuresExpanded(
                    navigation.expandedDirectories,
                    keys,
                    isExpanded,
                ),
            }),
        setFileHistoryExpanded,
        setGroupExpanded: (groupId, isExpanded) =>
            updateNavigation({
                expandedGroups: { ...navigation.expandedGroups, [groupId]: isExpanded },
            }),
        setProviderExpanded: (providerId, isExpanded) =>
            updateNavigation({
                expandedProviders: {
                    ...navigation.expandedProviders,
                    [providerId]: isExpanded,
                },
            }),
        setSubtreeExpanded: ({ directoryKeys, groupIds, providerId }, isExpanded) =>
            updateNavigation({
                expandedDirectories: setSourceControlDisclosuresExpanded(
                    navigation.expandedDirectories,
                    directoryKeys,
                    isExpanded,
                ),
                expandedGroups: setSourceControlDisclosuresExpanded(
                    navigation.expandedGroups,
                    groupIds,
                    isExpanded,
                ),
                ...(providerId && {
                    expandedProviders: {
                        ...navigation.expandedProviders,
                        [providerId]: isExpanded,
                    },
                }),
            }),
        status: 'ready',
    };
}
