import type { SourceControlViewState } from '@caxri/protocol';
import { MAX_SOURCE_CONTROL_VIEW_STATE_ENTRIES } from '@caxri/protocol';

export type SourceControlViewNavigation = SourceControlViewState;

export function setSourceControlDirectoriesExpanded(
    current: Readonly<Record<string, boolean>>,
    keys: readonly string[],
    isExpanded: boolean,
): Record<string, boolean> {
    const next = { ...current };
    for (const key of keys) delete next[key];
    /**
     * The persistence boundary retains the newest entries. A recursive batch arrives root-first, so writing it in
     * reverse keeps the clicked root and its nearest descendants ahead of deep nodes.
     */
    for (const key of keys.toReversed()) next[key] = isExpanded;
    return next;
}

export function createSourceControlViewNavigation(
    persisted?: SourceControlViewState,
): SourceControlViewNavigation {
    return persisted
        ? {
              ...persisted,
              expandedDirectories: { ...persisted.expandedDirectories },
              expandedGroups: { ...persisted.expandedGroups },
              expandedProviders: { ...persisted.expandedProviders },
          }
        : {
              expandedDirectories: {},
              expandedGroups: {},
              expandedProviders: {},
          };
}

function boundedDisclosureState(state: Readonly<Record<string, boolean>>): Record<string, boolean> {
    return Object.fromEntries(Object.entries(state).slice(-MAX_SOURCE_CONTROL_VIEW_STATE_ENTRIES));
}

export function updateSourceControlViewNavigation(
    navigation: SourceControlViewNavigation,
    patch: Partial<SourceControlViewNavigation>,
): SourceControlViewNavigation {
    return {
        ...navigation,
        ...patch,
    };
}

export function serializeSourceControlViewNavigation(
    navigation: SourceControlViewNavigation,
): SourceControlViewState {
    return {
        expandedDirectories: boundedDisclosureState(navigation.expandedDirectories),
        expandedGroups: boundedDisclosureState(navigation.expandedGroups),
        expandedProviders: boundedDisclosureState(navigation.expandedProviders),
        ...(navigation.modeId && { modeId: navigation.modeId }),
    };
}
