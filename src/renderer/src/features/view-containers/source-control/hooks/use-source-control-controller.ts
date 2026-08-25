import { useCallback, useEffect, useRef, useState } from 'react';

import type {
    SourceControlAction,
    SourceControlActionEffect,
    SourceControlViewModel,
} from '@shared/views';
import { useQuery } from '@tanstack/react-query';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { executeViewCatalogShortcut } from '../../../../features/view-containers/view-container-commands';
import { useToastOnQueryError } from '../../../../queries/client';
import { useSelectedSession, useSettings } from '../../../../stores/selectors';
import { pushToast, tryCommand } from '../../../../stores/toasts';
import { openEditorTab } from '../../../editor/document-actions';
import { useActivePaneTab } from '../../../workbench/pane-actions';
import { useControlledView, useSourceControlClient } from '../../controlled-view-context';
import { subscribeViewEvents } from '../../view-event-bridge';
import { controlledViewQueryKey } from '../../view-operation-client';
import type { SourceControlViewNavigation } from '../source-control-state';
import {
    sourceControlNavigationForScope,
    updateSourceControlViewNavigation,
} from '../source-control-state';

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

/**
 * Owns generic provider-model fetching, scoped disclosure state, action effects, and focus sequencing.
 */
export function useSourceControlController(): SourceControlController {
    const { configurationDependencies, presentation, providerGeneration, viewId } =
        useControlledView();
    const client = useSourceControlClient();
    const session = useSelectedSession();
    const settings = useSettings();
    const activeResource = useActivePaneTab()?.resource;
    const scope = session ? `${session.id}:${session.workbenchProjectId}` : undefined;
    const [navigationByScope, setNavigationByScope] = useState<
        Record<string, SourceControlViewNavigation>
    >({});
    const [refresh, setRefresh] = useState(0);
    const [flashedProviderId, setFlashedProviderId] = useState<string>();
    const reduceMotion = useShouldReduceMotion();
    const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(flashTimer.current), []);
    const navigation = sourceControlNavigationForScope(navigationByScope, scope);
    const updateNavigation = useCallback(
        (patch: Partial<SourceControlViewNavigation>): void => {
            if (!scope) return;
            setNavigationByScope((current) =>
                updateSourceControlViewNavigation(
                    current,
                    scope,
                    sourceControlNavigationForScope(current, scope),
                    patch,
                ),
            );
        },
        [scope],
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
    const snapshot = useQuery({
        queryKey: controlledViewQueryKey(
            viewId,
            'source.snapshot',
            snapshotRequest,
            scope,
            configRevision,
        ),
        queryFn: ({ signal }) => client.snapshot(snapshotRequest, signal),
        enabled: Boolean(session),
    });
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
            if (action.disabled || !snapshot.data) return;
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
        [client, focusProvider, presentation?.actionErrorMessage, snapshot.data],
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
