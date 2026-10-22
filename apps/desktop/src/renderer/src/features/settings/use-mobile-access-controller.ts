import { useCallback, useEffect, useMemo, useReducer } from 'react';

import type { MobileAccessStatus, MobileDeviceSummary, ProjectQueryResult } from '@caxri/protocol';
import { MOBILE_MAX_PROJECT_GRANTS } from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import {
    createMobilePairing,
    listMobileDevices,
    listMobileGrantableProjects,
    mobileAccessStatus,
    revokeMobileDevice,
    setMobileAccessEnabled,
} from './mobile-access-client';
import { splitGrantableProjects, summarizeProjectAccess } from './mobile-access-summary';

export interface MobilePairingState {
    expiresAt: number;
    knownDeviceIds: Set<string>;
    pairingLink: string;
}

export interface MobileAccessState {
    busy: boolean;
    copied: boolean;
    devices: MobileDeviceSummary[];
    /**
     * Stored as a key so the message follows a language change while it is on screen.
     */
    error?: TranslationKey;
    loadState: 'error' | 'loading' | 'ready';
    now: number;
    pairing?: MobilePairingState;
    /**
     * The Projects a pairing can grant, without auto-registered worktree Projects (see `splitGrantableProjects`).
     */
    projects: ProjectQueryResult['projects'];
    selectedProjectIds: Set<string>;
    status?: MobileAccessStatus;
    /**
     * Worktree Project ids an older pairing may still hold. The device's Access line skips them instead of counting
     * them as unavailable, matching what the phone shows.
     */
    worktreeProjectIds: ReadonlySet<string>;
}

export type MobileAccessAction =
    | {
          devices: MobileDeviceSummary[];
          projects: ProjectQueryResult['projects'];
          status: MobileAccessStatus;
          type: 'loaded';
          worktreeProjectIds: ReadonlySet<string>;
      }
    | { busy: boolean; type: 'set-busy' }
    | { copied: boolean; type: 'set-copied' }
    | { error?: TranslationKey; type: 'set-error' }
    | {
          devices: MobileDeviceSummary[];
          now: number;
          pairingCompleted: boolean;
          type: 'pairing-polled';
      }
    | {
          now: number;
          pairing: MobilePairingState;
          status: MobileAccessStatus;
          type: 'pairing-created';
      }
    | { isEnabled: boolean; status: MobileAccessStatus; type: 'access-applied' }
    | { isChecked: boolean; projectId: string; type: 'project-toggled' }
    | { type: 'load-failed' }
    | { type: 'load-started' };

export const initialMobileAccessState: MobileAccessState = {
    busy: false,
    copied: false,
    devices: [],
    loadState: 'loading',
    now: 0,
    projects: [],
    selectedProjectIds: new Set(),
    worktreeProjectIds: new Set(),
};

export const mobileAccessReducer = (
    state: MobileAccessState,
    action: MobileAccessAction,
): MobileAccessState => {
    switch (action.type) {
        case 'loaded':
            return {
                ...state,
                devices: action.devices,
                error: undefined,
                loadState: 'ready',
                projects: action.projects,
                selectedProjectIds:
                    state.selectedProjectIds.size > 0
                        ? state.selectedProjectIds
                        : new Set(
                              action.projects
                                  .slice(0, MOBILE_MAX_PROJECT_GRANTS)
                                  .map((project) => project.id),
                          ),
                status: action.status,
                worktreeProjectIds: action.worktreeProjectIds,
            };
        case 'set-busy':
            return { ...state, busy: action.busy };
        case 'set-copied':
            return { ...state, copied: action.copied };
        case 'set-error':
            return { ...state, error: action.error };
        case 'load-failed':
            return {
                ...state,
                error: 'settings.mobileAccess.error.load',
                loadState: 'error',
            };
        case 'load-started':
            return { ...state, error: undefined, loadState: 'loading' };
        case 'pairing-polled':
            return {
                ...state,
                devices: action.devices,
                now: action.now,
                pairing: action.pairingCompleted ? undefined : state.pairing,
            };
        case 'pairing-created':
            return {
                ...state,
                copied: false,
                now: action.now,
                pairing: action.pairing,
                status: action.status,
            };
        case 'access-applied':
            return {
                ...state,
                pairing: action.isEnabled ? state.pairing : undefined,
                status: action.status,
            };
        case 'project-toggled': {
            const selectedProjectIds = new Set(state.selectedProjectIds);
            if (action.isChecked) selectedProjectIds.add(action.projectId);
            else selectedProjectIds.delete(action.projectId);
            return { ...state, selectedProjectIds };
        }
    }
};

export const useMobileAccessController = () => {
    const { t } = useTranslation();
    const [state, dispatch] = useReducer(mobileAccessReducer, initialMobileAccessState);

    const load = useCallback(async (): Promise<void> => {
        dispatch({ type: 'load-started' });
        try {
            const [status, devices, projects] = await Promise.all([
                mobileAccessStatus(),
                listMobileDevices(),
                listMobileGrantableProjects(),
            ]);
            dispatch({
                devices: devices.devices,
                ...splitGrantableProjects(projects),
                status,
                type: 'loaded',
            });
        } catch {
            dispatch({ type: 'load-failed' });
        }
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => {
            // eslint-disable-next-line no-void -- This effect owns the initial settings request.
            void load();
        }, 0);
        return () => clearTimeout(timer);
    }, [load]);

    useEffect(() => {
        if (!state.pairing) return;
        let isActive = true;
        let isLoading = false;
        const refreshPairing = async (): Promise<void> => {
            if (isLoading) return;
            isLoading = true;
            const now = Date.now();
            try {
                const result = await listMobileDevices();
                if (isActive) {
                    const pairingCompleted = result.devices.some(
                        (device) =>
                            device.revokedAt === undefined &&
                            !state.pairing?.knownDeviceIds.has(device.deviceId),
                    );
                    dispatch({
                        devices: result.devices,
                        now,
                        pairingCompleted,
                        type: 'pairing-polled',
                    });
                }
            } catch {
                // The existing QR remains usable while a transient Desktop request retries.
            }
            // After the try/catch rather than in a `finally`, which React Compiler cannot lower; the catch never rethrows.
            isLoading = false;
        };
        const poll = (): void => {
            // eslint-disable-next-line no-void -- This effect owns one bounded pairing-status poll.
            void refreshPairing();
        };
        poll();
        const timer = setInterval(poll, 1_000);
        return () => {
            isActive = false;
            clearInterval(timer);
        };
    }, [state.pairing]);

    const applyAccess = async (isEnabled: boolean): Promise<void> => {
        dispatch({ busy: true, type: 'set-busy' });
        dispatch({ error: undefined, type: 'set-error' });
        try {
            const status = await setMobileAccessEnabled(isEnabled);
            dispatch({ isEnabled, status, type: 'access-applied' });
        } catch {
            dispatch({
                error: isEnabled
                    ? 'settings.mobileAccess.error.enable'
                    : 'settings.mobileAccess.error.disable',
                type: 'set-error',
            });
        }
        // After the try/catch rather than in a `finally`, which React Compiler cannot lower; the catch never rethrows.
        dispatch({ busy: false, type: 'set-busy' });
    };

    const createPairing = async (): Promise<void> => {
        if (!state.status || state.selectedProjectIds.size === 0) return;
        dispatch({ busy: true, type: 'set-busy' });
        dispatch({ copied: false, type: 'set-copied' });
        dispatch({ error: undefined, type: 'set-error' });
        try {
            const pairing = await createMobilePairing({
                projectIds: [...state.selectedProjectIds],
            });
            dispatch({
                now: Date.now(),
                pairing: {
                    ...pairing,
                    knownDeviceIds: new Set(
                        state.devices
                            .filter((device) => device.revokedAt === undefined)
                            .map((device) => device.deviceId),
                    ),
                },
                status: state.status,
                type: 'pairing-created',
            });
            try {
                const status = await mobileAccessStatus();
                dispatch({ isEnabled: true, status, type: 'access-applied' });
            } catch {
                // A transient status refresh must not discard the already-issued pairing link.
            }
        } catch {
            dispatch({ error: 'settings.mobileAccess.error.createPairing', type: 'set-error' });
        }
        // After the try/catch rather than in a `finally`, which React Compiler cannot lower; the catch never rethrows.
        dispatch({ busy: false, type: 'set-busy' });
    };

    const revoke = async (deviceId: string): Promise<void> => {
        dispatch({ busy: true, type: 'set-busy' });
        dispatch({ error: undefined, type: 'set-error' });
        try {
            await revokeMobileDevice({ deviceId });
            await load();
        } catch {
            dispatch({ error: 'settings.mobileAccess.error.revoke', type: 'set-error' });
        }
        // After the try/catch rather than in a `finally`, which React Compiler cannot lower; the catch never rethrows.
        dispatch({ busy: false, type: 'set-busy' });
    };

    const copyPairingLink = async (): Promise<void> => {
        if (!state.pairing || state.pairing.expiresAt <= Date.now()) return;
        try {
            await navigator.clipboard.writeText(state.pairing.pairingLink);
            dispatch({ copied: true, type: 'set-copied' });
            dispatch({ error: undefined, type: 'set-error' });
        } catch {
            dispatch({ error: 'settings.mobileAccess.error.copyLink', type: 'set-error' });
        }
    };

    const activeDevices = useMemo(
        () => state.devices.filter((device) => device.revokedAt === undefined),
        [state.devices],
    );
    const projectAccessByDevice = useMemo(() => {
        const projectTitles = new Map(
            state.projects.map((project) => [project.id, project.displayTitle]),
        );
        return new Map(
            activeDevices.map((device) => [
                device.deviceId,
                summarizeProjectAccess(
                    t,
                    device.projectIds
                        .filter((projectId) => !state.worktreeProjectIds.has(projectId))
                        .map((projectId) => projectTitles.get(projectId)),
                ),
            ]),
        );
    }, [activeDevices, state.projects, state.worktreeProjectIds, t]);

    return {
        ...state,
        activeDevices,
        applyAccess,
        copyPairingLink,
        createPairing,
        isPairingActive: state.pairing !== undefined && state.pairing.expiresAt > state.now,
        projectAccessByDevice,
        reload: load,
        revoke,
        toggleProject: (projectId: string, isChecked: boolean): void =>
            dispatch({ isChecked, projectId, type: 'project-toggled' }),
    };
};
