import { useCallback, useEffect, useRef, useState } from 'react';

import type { AppSettings, ProjectRecord, SessionRecord } from '@shared/types';
import { isEqual } from 'es-toolkit';

import type { ProjectCollapseState } from '../project-collapse';
import {
    autoCollapseThresholdMs,
    parseProjectCollapseState,
    projectCollapseAfterPolicy,
} from '../project-collapse';

const STORAGE_KEY = 'caxri.sidebar-project-collapse.v1';
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

function writePersistedState(state: ProjectCollapseState): void {
    if (!isBrowser()) return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        // Storage-disabled windows keep the disclosure state for this Renderer lifetime.
    }
}

interface UseProjectCollapseInput {
    autoCollapseSetting: AppSettings['sidebar.autoCollapseProjects'];
    projects: readonly ProjectRecord[] | undefined;
    selectedSessionId: string | undefined;
    sessions: readonly SessionRecord[];
}

export function useProjectCollapse(input: UseProjectCollapseInput) {
    const { autoCollapseSetting, projects, selectedSessionId, sessions } = input;
    const [collapsedProjects, setCollapsedProjects] = useState<ProjectCollapseState>(() =>
        readPersistedState(),
    );
    const [hasFocus, setHasFocus] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const manuallyExpandedProjectIds = useRef(new Set<string>());

    const update = useCallback((next: ProjectCollapseState): void => {
        setCollapsedProjects((current) => (isEqual(current, next) ? current : next));
    }, []);

    useEffect(() => writePersistedState(collapsedProjects), [collapsedProjects]);

    const applyPolicy = useCallback(
        (shouldAutoCollapse: boolean): void => {
            update(
                projectCollapseAfterPolicy({
                    autoCollapseThresholdMs: autoCollapseThresholdMs(autoCollapseSetting),
                    collapsedProjects,
                    manuallyExpandedProjectIds: manuallyExpandedProjectIds.current,
                    now: Date.now(),
                    projects,
                    selectedSessionId,
                    sessions,
                    shouldAutoCollapse,
                }),
            );
        },
        [autoCollapseSetting, collapsedProjects, projects, selectedSessionId, sessions, update],
    );

    useEffect(() => {
        applyPolicy(false);
        if (hasFocus || isHovered || autoCollapseThresholdMs(autoCollapseSetting) === undefined)
            return;
        const timeout = setTimeout(() => applyPolicy(true), AUTO_COLLAPSE_IDLE_DELAY_MS);
        const interval = setInterval(() => applyPolicy(true), AUTO_COLLAPSE_RECHECK_MS);
        return () => {
            clearTimeout(timeout);
            clearInterval(interval);
        };
    }, [applyPolicy, autoCollapseSetting, hasFocus, isHovered]);

    const toggleProject = useCallback(
        (projectId: string): void => {
            const next = { ...collapsedProjects };
            if (collapsedProjects[projectId]) {
                delete next[projectId];
                manuallyExpandedProjectIds.current.add(projectId);
            } else {
                next[projectId] = 'manual';
                manuallyExpandedProjectIds.current.delete(projectId);
            }
            update(next);
        },
        [collapsedProjects, update],
    );

    const isProjectExpanded = useCallback(
        (projectId: string): boolean => collapsedProjects[projectId] === undefined,
        [collapsedProjects],
    );

    return {
        isProjectExpanded,
        setHasFocus,
        setIsHovered,
        toggleProject,
    };
}
