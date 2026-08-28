import { useCallback, useEffect, useRef, useState } from 'react';

import type {
    SourceControlAction,
    SourceControlActionEffect,
    SourceControlViewModel,
    SourceControlViewState,
} from '@caxri/protocol';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { executeViewCatalogShortcut } from '../../../../features/view-containers/view-container-commands';
import { useToastOnQueryError } from '../../../../queries/client';
import { useSelectedSession, useSettings } from '../../../../stores/selectors';
import { pushToast, tryCommand } from '../../../../stores/toasts';
import { openEditorTab } from '../../../editor/document-actions';
import { useActivePaneTab } from '../../../workbench/pane-actions';
import { useControlledView, useSourceControlClient } from '../../controlled-view-context';
import { subscribeViewEvents } from '../../view-event-bridge';
import type { SourceControlClient } from '../../view-operation-client';
import { controlledViewQueryKey } from '../../view-operation-client';
import type { SourceControlViewNavigation } from '../source-control-state';
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

interface SourceControlViewEmptyController {
    message: string;
    status: 'empty';
}

interface SourceControlViewReadyController {
    activeEditorResource: string | undefined;
    flashedProviderId: string | undefined;
    focusProvider: (targetId: string) => void;
    isRefreshing: boolean;
    model: SourceControlViewModel;
    navigation: SourceControlViewNavigation;
    runAction: (action: SourceControlAction) => Promise<void>;
    selectMode: (mode: SourceControlMode) => void;
    setDirectoryExpanded: (key: string, isExpanded: boolean) => void;
    setGroupExpanded: (groupId: string, isExpanded: boolean) => void;
    setProviderExpanded: (providerId: string, isExpanded: boolean) => void;
    status: 'ready';
}

export type SourceControlController =
    SourceControlViewEmptyController | SourceControlViewReadyController;

function requestedModeFromQueryKey(queryKey: readonly unknown[]): string | undefined {
    const parameters = queryKey[1];
    if (typeof parameters !== 'object' || parameters === null) return;
    const arguments_ = (parameters as { arguments?: unknown }).arguments;
    if (typeof arguments_ !== 'object' || arguments_ === null) return;
    const preferredModeId = (arguments_ as { preferredModeId?: unknown }).preferredModeId;
    return typeof preferredModeId === 'string' ? preferredModeId : undefined;
}

/**
 * Keeps the last resolved tree visible while a same-requested-mode refresh advances the query generation. Comparing
 * request keys instead of the provider's selected mode also covers a persisted mode that the provider had to replace
 * with a fallback. A real mode switch receives no placeholder, so Working Tree, Commit, and Pull Request data are never
 * presented as each other while the newly selected model loads.
 *
 * Session and Workbench Root changes remount `ScopedSourceControlView` with a new scope key, so placeholder data never
 * crosses those ownership boundaries.
 */
export function sourceControlSnapshotQueryOptions({
    client,
    configRevision,
    enabled,
    queryScope,
    request,
    viewId,
}: {
    client: Pick<SourceControlClient, 'snapshot'>;
    configRevision: string;
    enabled: boolean;
    queryScope?: string;
    request: { preferredModeId?: string; refresh: number };
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
        queryFn: ({ signal }) => client.snapshot(request, signal),
        enabled,
        placeholderData: (previousData, previousQuery) =>
            requestedModeFromQueryKey(previousQuery?.queryKey ?? []) === request.preferredModeId
                ? previousData
                : undefined,
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
    const activeResource = useActivePaneTab()?.resource;
    const queryScope = session ? `${session.id}:${session.workbenchProjectId}` : undefined;
    const [refresh, setRefresh] = useState(0);
    const [flashedProviderId, setFlashedProviderId] = useState<string>();
    const reduceMotion = useShouldReduceMotion();
    const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(flashTimer.current), []);
    const [navigation, updateNavigation] = useSourceControlNavigation(
        navigationScope,
        persistedNavigation,
    );
    const snapshotRequest = {
        refresh,
        ...(navigation.modeId && { preferredModeId: navigation.modeId }),
    };
    const configRevision = JSON.stringify(
        configurationDependencies.map((key) => [
            key,
            (settings as Readonly<Record<string, unknown>> | undefined)?.[key],
        ]),
    );
    const snapshot = useQuery(
        sourceControlSnapshotQueryOptions({
            client,
            configRevision,
            enabled: Boolean(session),
            queryScope,
            request: snapshotRequest,
            viewId,
        }),
    );
    useToastOnQueryError(
        snapshot.isError,
        snapshot.error,
        presentation?.refreshErrorMessage ?? 'Source Control refresh failed',
    );
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
                          if (event.payload.change.kind === 'refresh')
                              setRefresh((value) => value + 1);
                          else if (event.payload.change.kind === 'selection')
                              updateNavigation({
                                  modeId: event.payload.change.selectedModeId,
                              });
                      },
                  ),
        [providerGeneration, session, updateNavigation, viewId],
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
        [navigation.expandedProviders, reduceMotion, updateNavigation],
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
            if (result.refresh) setRefresh((value) => value + 1);
        },
        [
            client,
            focusProvider,
            presentation?.actionErrorMessage,
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
    if (!session)
        return {
            message:
                presentation?.noContextMessage ?? 'Select a context to inspect Source Control.',
            status: 'empty',
        };
    if (!snapshot.data)
        return {
            message: presentation?.loadingMessage ?? 'Loading Source Control…',
            status: 'empty',
        };
    if (snapshot.data.emptyMessage) return { message: snapshot.data.emptyMessage, status: 'empty' };

    return {
        activeEditorResource: activeResource?.kind === 'file' ? activeResource.path : undefined,
        flashedProviderId,
        focusProvider,
        isRefreshing: snapshot.isFetching,
        model: snapshot.data,
        navigation,
        runAction,
        selectMode,
        setDirectoryExpanded: (key, isExpanded) =>
            updateNavigation({
                expandedDirectories: {
                    ...navigation.expandedDirectories,
                    [key]: isExpanded,
                },
            }),
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
