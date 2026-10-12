import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AppSettings, ProjectRecord, SessionRecord } from '@caxri/protocol';
import { isEqual } from 'es-toolkit';

import type { ProjectCollapseState } from '../project-collapse';
import {
    autoCollapseThresholdMs,
    isProjectCollapsed,
    parseProjectCollapseState,
    projectCollapseAfterAutoPass,
    projectCollapseAfterReveal,
    projectCollapseAfterToggle,
    reconcileProjectCollapse,
} from '../project-collapse';

/**
 * `v2` records the user's expansions as well as their collapses, so the stored vocabulary changed. Unrecognized values
 * are dropped rather than translated: this is local view state, and starting an unknown Project expanded is the same
 * thing a first launch does.
 */
const STORAGE_KEY = 'caxri.primary-sidebar-project-collapse.v2';
const AUTO_COLLAPSE_IDLE_DELAY_MS = 500;
const AUTO_COLLAPSE_RECHECK_MS = 60 * 1000;

function isBrowser(): boolean {
    // DOM types declare these globals as always present, but this module also loads in Vitest's Node environment.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
    return typeof window !== 'undefined' && globalThis.localStorage !== undefined;
}

function readPersistedState(): ProjectCollapseState {
    if (!isBrowser()) return {};
    return parseProjectCollapseState(localStorage.getItem(STORAGE_KEY));
}

function writePersistedState(serialized: string): void {
    if (!isBrowser()) return;
    try {
        localStorage.setItem(STORAGE_KEY, serialized);
    } catch {
        // Storage-disabled windows keep the disclosure state for this Renderer lifetime.
    }
}

interface UseProjectCollapseInput {
    autoCollapseSetting: AppSettings['primarySidebar.autoCollapseProjects'];
    projects: readonly ProjectRecord[] | undefined;
    selectedSessionId: string | undefined;
    sessions: readonly SessionRecord[];
}

export function useProjectCollapse(input: UseProjectCollapseInput) {
    const { autoCollapseSetting, projects, selectedSessionId, sessions } = input;
    const [storedDisclosure, setStoredDisclosure] =
        useState<ProjectCollapseState>(readPersistedState);
    const [hasFocus, setHasFocus] = useState(false);
    const [isHovered, setIsHovered] = useState(false);

    /**
     * What the sidebar actually renders. Reconciling stored decisions against the live catalog is a pure function of
     * both, so it is derived here rather than written back into state from an effect: that shape renders the stale
     * value first and pays a second render pass on every Workbench refresh to correct it.
     */
    const disclosure = useMemo(
        () =>
            reconcileProjectCollapse({
                collapsedProjects: storedDisclosure,
                projects,
                selectedSessionId,
                sessions,
            }),
        [storedDisclosure, projects, selectedSessionId, sessions],
    );

    /**
     * Persisted from the serialized form rather than the object: the reconciliation allocates a fresh record on every
     * Workbench refresh, so an object-identity dependency would rewrite identical JSON dozens of times a minute.
     */
    const serializedDisclosure = useMemo(() => JSON.stringify(disclosure), [disclosure]);
    useEffect(() => writePersistedState(serializedDisclosure), [serializedDisclosure]);

    const autoCollapse = useCallback((): void => {
        setStoredDisclosure((current) => {
            const next = projectCollapseAfterAutoPass({
                autoCollapseThresholdMs: autoCollapseThresholdMs(autoCollapseSetting),
                collapsedProjects: current,
                now: Date.now(),
                projects,
                selectedSessionId,
                sessions,
            });
            return isEqual(current, next) ? current : next;
        });
    }, [autoCollapseSetting, projects, selectedSessionId, sessions]);

    useEffect(() => {
        if (hasFocus || isHovered || autoCollapseThresholdMs(autoCollapseSetting) === undefined)
            return;
        const timeout = setTimeout(autoCollapse, AUTO_COLLAPSE_IDLE_DELAY_MS);
        const interval = setInterval(autoCollapse, AUTO_COLLAPSE_RECHECK_MS);
        return () => {
            clearTimeout(timeout);
            clearInterval(interval);
        };
    }, [autoCollapse, autoCollapseSetting, hasFocus, isHovered]);

    const toggleProject = useCallback(
        (projectId: string): void => {
            // Toggles the reconciled view, not the raw record: an automatic collapse the reconciliation already
            // dropped must read as expanded here, or the first click on that row would appear to do nothing.
            setStoredDisclosure(projectCollapseAfterToggle(disclosure, projectId));
        },
        [disclosure],
    );

    const expandProject = useCallback(
        (projectId: string): void => {
            // Reveals against the reconciled view for the same reason `toggleProject` does: an automatic collapse the
            // reconciliation already dropped is open on screen, and re-recording it would be a decision the user never
            // made. An already open Project returns early: `disclosure` is a fresh reconciled object, so storing it
            // would cost the whole PrimarySidebar a render on every Session selection (`useSelectedSessionReveal`).
            if (!isProjectCollapsed(disclosure, projectId)) return;
            setStoredDisclosure(projectCollapseAfterReveal(disclosure, projectId));
        },
        [disclosure],
    );

    const isProjectExpanded = useCallback(
        (projectId: string): boolean => !isProjectCollapsed(disclosure, projectId),
        [disclosure],
    );

    return {
        expandProject,
        isProjectExpanded,
        setHasFocus,
        setIsHovered,
        toggleProject,
    };
}
