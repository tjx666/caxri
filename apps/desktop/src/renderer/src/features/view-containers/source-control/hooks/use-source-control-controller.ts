import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
    PaneResource,
    SourceControlAction,
    SourceControlActionEffect,
    SourceControlViewModel,
    SourceControlViewState,
} from '@caxri/protocol';
import { isVirtualEditorTabPath } from '@caxri/protocol';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import {
    executeViewCatalogShortcut,
    invalidateControlledViewSnapshot,
} from '../../../../features/view-containers/view-container-commands';
import { useToastOnQueryError } from '../../../../queries/client';
import { useSelectedSession, useSettings } from '../../../../stores/selectors';
import { pushToast, tryCommand } from '../../../../stores/toasts';
import { openEditorTab } from '../../../editor/document-actions';
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
import type { SourceControlPanelState } from '../source-control-panel-state';
import { resolveSourceControlPanelState } from '../source-control-panel-state';
import type { SourceControlViewNavigation } from '../source-control-state';
import { setSourceControlDirectoriesExpanded } from '../source-control-state';
import type { SourceControlNavigationScope } from './use-source-control-navigation';
import { useSourceControlNavigation } from './use-source-control-navigation';

type SourceControlMode = SourceControlViewModel['modes'][number];

function applyActionEffect(
    effect: SourceControlActionEffect,
    focusProvider: (targetId: string) => void,
): void {
    if (effect.kind === 'open-editor') openEditorTab(effect.resource);
    else if (effect.kind === 'focus') focusProvider(effect.targetId);
    else pushToast(effect.tone, effect.message);
}

type SourceControlViewEmptyController = Exclude<SourceControlPanelState, { status: 'ready' }> & {
    isRefreshing: boolean;
    loadingMessage: string;
    noContextMessage: string;
    refresh: () => void;
};

interface SourceControlViewReadyController {
    activeEditorResource: string | undefined;
    fileHistoryExpanded: boolean;
    flashedProviderId: string | undefined;
    focusProvider: (targetId: string) => void;
    isRefreshing: boolean;
    model: SourceControlViewModel;
    navigation: SourceControlViewNavigation;
    runAction: (action: SourceControlAction) => Promise<void>;
    selectMode: (mode: SourceControlMode) => void;
    setDirectoriesExpanded: (keys: readonly string[], isExpanded: boolean) => void;
    setFileHistoryExpanded: Dispatch<SetStateAction<boolean>>;
    setGroupExpanded: (groupId: string, isExpanded: boolean) => void;
    setProviderExpanded: (providerId: string, isExpanded: boolean) => void;
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
 * Owns generic provider-model fetching, scoped disclosure state, action effects, and focus sequencing.
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
    const [flashedProviderId, setFlashedProviderId] = useState<string>();
    const reduceMotion = useShouldReduceMotion();
    const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(flashTimer.current), []);
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
    const focusProvider = useCallback(
        (targetId: string): void => {
            const isExpanded = navigation.expandedProviders[targetId] ?? true;
            updateNavigation({
                expandedProviders: {
                    ...navigation.expandedProviders,
                    [targetId]: !isExpanded,
                },
            });
            setFlashedProviderId(targetId);
            clearTimeout(flashTimer.current);
            flashTimer.current = setTimeout(() => setFlashedProviderId(undefined), 1600);
            requestAnimationFrame(() => {
                document
                    .querySelector(`[data-git-repository-id="${CSS.escape(targetId)}"]`)
                    ?.scrollIntoView({
                        behavior: reduceMotion ? 'auto' : 'smooth',
                        block: 'nearest',
                    });
            });
        },
        [navigation.expandedProviders, reduceMotion, setFlashedProviderId, updateNavigation],
    );
    const runAction = useCallback(
        async (action: SourceControlAction): Promise<void> => {
            if (action.disabled || snapshot.isFetching || !snapshot.data) return;
            const revision = snapshot.data.revision;
            const result = await tryCommand(
                action.errorMessage ??
                    presentation?.actionErrorMessage ??
                    'Source Control action failed',
                () => client.action({ actionId: action.id, revision }),
            );
            if (!result || result.revision !== revision) return;
            for (const effect of result.effects) applyActionEffect(effect, focusProvider);
            if (result.refresh) requestRefresh();
        },
        [
            client,
            focusProvider,
            presentation?.actionErrorMessage,
            requestRefresh,
            snapshot.data,
            snapshot.isFetching,
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
        flashedProviderId,
        focusProvider,
        isRefreshing: snapshot.isFetching,
        model: snapshot.data,
        navigation,
        runAction,
        selectMode,
        setDirectoriesExpanded: (keys, isExpanded) =>
            updateNavigation({
                expandedDirectories: setSourceControlDirectoriesExpanded(
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
        status: 'ready',
    };
}
