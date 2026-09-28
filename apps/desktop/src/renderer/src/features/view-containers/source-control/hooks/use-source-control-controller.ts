import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useState } from 'react';

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
import { useToastOnQueryError } from '../../../../queries/client';
import { useSelectedSession, useSettings } from '../../../../stores/selectors';
import { pushToast, tryCommand } from '../../../../stores/toasts';
import { openEditorTab } from '../../../editor/document-commands';
import { useActivePaneTab } from '../../../workbench/pane-actions';
import { useControlledView, useSourceControlClient } from '../../controlled-view-context';
import {
    isViewContainerQueryEnabled,
    useCancelViewContainerQueryWhenHidden,
    useIsViewContainerActive,
} from '../../view-container-activity';
import { subscribeViewEvents } from '../../view-event-bridge';
import type { SourceControlClient } from '../../view-operation-client';
import { controlledViewQueryKey } from '../../view-operation-client';
import { findSourceControlActionByCommand } from '../source-control-action-resolution';
import { REFRESHING_ACTION_MESSAGE } from '../source-control-history-state';
import type { SourceControlPanelState } from '../source-control-panel-state';
import { resolveSourceControlPanelState } from '../source-control-panel-state';
import type { SourceControlViewNavigation } from '../source-control-state';
import { setSourceControlDisclosuresExpanded } from '../source-control-state';
import type { SourceControlNavigationScope } from './use-source-control-navigation';
import { useSourceControlNavigation } from './use-source-control-navigation';

type SourceControlMode = SourceControlViewModel['modes'][number];

/**
 * The provider refused an action because its model revision had already moved on; see `ExtensionService.viewOperation`.
 */
const SUPERSEDED = Symbol('superseded');

function applyActionEffect(effect: SourceControlActionEffect): void {
    if (effect.kind === 'open-editor') openEditorTab(effect.resource);
    else pushToast(effect.tone, effect.message);
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
    const { configurationDependencies, presentation, providerGeneration, viewId } =
        useControlledView();
    const client = useSourceControlClient();
    const session = useSelectedSession();
    const settings = useSettings();
    const isContainerActive = useIsViewContainerActive();
    const activeResource = useActivePaneTab()?.resource;
    const queryScope = session ? `${session.id}:${session.workbenchProjectId}` : undefined;
    const [fileHistoryExpanded, setFileHistoryExpanded] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const [navigation, updateNavigation] = useSourceControlNavigation(
        navigationScope,
        persistedNavigation,
    );
    const snapshotRequest = buildSourceControlSnapshotRequest(activeResource, navigation.modeId);
    const configRevision = JSON.stringify(
        configurationDependencies.map((key) => [
            key,
            (settings as Readonly<Record<string, unknown>> | undefined)?.[key],
        ]),
    );
    const snapshotOptions = sourceControlSnapshotQueryOptions({
        client,
        configRevision,
        enabled: isViewContainerQueryEnabled(isContainerActive, Boolean(session)),
        queryScope,
        refresh,
        request: snapshotRequest,
        viewId,
    });
    useCancelViewContainerQueryWhenHidden(snapshotOptions.queryKey, isContainerActive);
    const snapshot = useQuery(snapshotOptions);
    const requestRefresh = useCallback(() => {
        setRefresh((current) => current + 1);
    }, []);
    useEffect(() => {
        if (refresh === 0) return;
        // eslint-disable-next-line no-void -- invalidateQueries reports through the snapshot observer
        void invalidateControlledViewSnapshot(viewId);
    }, [refresh, viewId]);
    useToastOnQueryError(
        snapshot.isError,
        snapshot.error,
        presentation?.refreshErrorMessage ?? 'Source Control refresh failed',
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
            !session
                ? () => {}
                : subscribeViewEvents(
                      {
                          viewId,
                          sessionId: session.id,
                          workbenchProjectId: session.workbenchProjectId,
                          extensionGeneration: providerGeneration,
                      },
                      (event) => {
                          if (event.payload.change.kind === 'refresh') requestRefresh();
                          else if (event.payload.change.kind === 'selection')
                              updateNavigation({
                                  modeId: event.payload.change.selectedModeId,
                              });
                      },
                  ),
        [providerGeneration, requestRefresh, session, updateNavigation, viewId],
    );
    const refetchSnapshot = snapshot.refetch;
    const runAction = useCallback(
        async (action: SourceControlAction): Promise<void> => {
            if (action.disabled || !snapshot.data) return;
            if (snapshot.isFetching) {
                pushToast('warning', REFRESHING_ACTION_MESSAGE);
                return;
            }
            const label =
                action.errorMessage ??
                presentation?.actionErrorMessage ??
                'Source Control action failed';
            const run = (target: SourceControlAction, revision: string) =>
                tryCommand(label, async () => {
                    try {
                        return await client.action({ actionId: target.id, revision });
                    } catch (error) {
                        if (isCaxriError(error) && error.code === 'CONFLICT') return SUPERSEDED;
                        throw error;
                    }
                });
            let revision = snapshot.data.revision;
            let result = await run(action, revision);
            if (result === SUPERSEDED) {
                /**
                 * A background refresh replaced the model between the click and the provider's revision check, so
                 * nothing ran. Replay the same command once against the model that won; `cancelRefetch: false` joins
                 * that refresh instead of restarting it.
                 */
                const fresh = (await refetchSnapshot({ cancelRefetch: false })).data;
                const replacement =
                    fresh && findSourceControlActionByCommand(fresh, action.command);
                if (fresh && replacement) {
                    revision = fresh.revision;
                    result = await run(replacement, revision);
                }
                if (result === SUPERSEDED) {
                    pushToast('warning', REFRESHING_ACTION_MESSAGE);
                    return;
                }
            }
            if (!result || result.revision !== revision) return;
            for (const effect of result.effects) applyActionEffect(effect);
            if (result.refresh) requestRefresh();
        },
        [
            client,
            presentation?.actionErrorMessage,
            requestRefresh,
            snapshot.data,
            snapshot.isFetching,
            refetchSnapshot,
        ],
    );
    const selectMode = useCallback(
        (mode: SourceControlMode): void => {
            updateNavigation({ modeId: mode.id });
            // eslint-disable-next-line no-void -- the shared catalog dispatcher owns extension command failures
            void executeViewCatalogShortcut(mode.command.id, mode.command.arguments ?? []);
        },
        [updateNavigation],
    );
    const panelState = resolveSourceControlPanelState({
        hasSession: Boolean(session),
        hasSnapshotError: snapshot.isError,
        model: snapshot.data,
    });
    if (panelState.status !== 'ready')
        return {
            ...panelState,
            isRefreshing: snapshot.isFetching,
            loadingMessage: presentation?.loadingMessage ?? 'Loading Git status…',
            noContextMessage:
                presentation?.noContextMessage ?? 'Pick a Session to inspect its Git state.',
            refresh: requestRefresh,
        };
    if (!snapshot.data)
        return {
            status: 'loading',
            isRefreshing: true,
            loadingMessage: presentation?.loadingMessage ?? 'Loading Git status…',
            noContextMessage:
                presentation?.noContextMessage ?? 'Pick a Session to inspect its Git state.',
            refresh: requestRefresh,
        };

    return {
        activeEditorResource: activeResource?.kind === 'file' ? activeResource.path : undefined,
        fileHistoryExpanded,
        isRefreshing: snapshot.isFetching,
        model: snapshot.data,
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
