import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AppSettings, ProjectRecord, SessionRecord } from '@caxri/protocol';
import { isEqual } from 'es-toolkit';

import type { ProjectCollapseState } from '../project-collapse';
import {
    autoCollapseThresholdMs,
    isProjectCollapsed,
    projectCollapseAfterAutoPass,
    projectCollapseAfterReveal,
    projectCollapseAfterToggle,
    reconcileProjectCollapse,
} from '../project-collapse';
import { createProjectCollapsePersistence } from '../project-collapse-persistence';

const AUTO_COLLAPSE_IDLE_DELAY_MS = 500;
const AUTO_COLLAPSE_RECHECK_MS = 60 * 1000;

interface UseProjectCollapseInput {
    autoCollapseSetting: AppSettings['primarySidebar.autoCollapseProjects'];
    /**
     * The group that holds each nested or hidden delegated Session (`DelegatedPlacement.groupIdBySessionId`), so a
     * running or unread child keeps its host's group open instead of its own Project.
     */
    groupIdBySessionId?: ReadonlyMap<string, string>;
    projects: readonly ProjectRecord[] | undefined;
    selectedSessionId: string | undefined;
    sessions: readonly SessionRecord[];
}

export function useProjectCollapse(input: UseProjectCollapseInput) {
    const { autoCollapseSetting, groupIdBySessionId, projects, selectedSessionId, sessions } =
        input;
    const [persistence] = useState(createProjectCollapsePersistence);
    const [storedDisclosure, setStoredDisclosure] = useState<ProjectCollapseState>(
        persistence.initial,
    );
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
                groupIdBySessionId,
                projects,
                selectedSessionId,
                sessions,
            }),
        [storedDisclosure, groupIdBySessionId, projects, selectedSessionId, sessions],
    );

    // Another window's collapse lands here and only updates memory. The persist effect below then has nothing of this
    // window's to write, so a change never echoes back.
    useEffect(() => persistence.subscribe(setStoredDisclosure), [persistence]);

    /**
     * Persists just the Projects whose disclosure changed (`projectCollapseChanges`), merged into the shared record at
     * write time. The reconciliation allocates a fresh record on every Workbench refresh, but an unchanged one yields
     * no changes, so a refresh costs a comparison and no write.
     */
    useEffect(
        () =>
            persistence.persist(
                disclosure,
                projects ? new Set(projects.map((project) => project.id)) : undefined,
            ),
        [persistence, disclosure, projects],
    );

    const autoCollapse = useCallback((): void => {
        setStoredDisclosure((current) => {
            const next = projectCollapseAfterAutoPass({
                autoCollapseThresholdMs: autoCollapseThresholdMs(autoCollapseSetting),
                collapsedProjects: current,
                groupIdBySessionId,
                now: Date.now(),
                projects,
                selectedSessionId,
                sessions,
            });
            return isEqual(current, next) ? current : next;
        });
    }, [autoCollapseSetting, groupIdBySessionId, projects, selectedSessionId, sessions]);

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
