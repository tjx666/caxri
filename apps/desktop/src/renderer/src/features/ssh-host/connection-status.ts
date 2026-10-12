import type {
    RemoteConnectionPhase,
    RemoteFailureReason,
    SshEnvironmentState,
} from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';

const phaseLabelKeys = {
    connecting: 'sshHost.phase.connecting',
    probing: 'sshHost.phase.probing',
    installing: 'sshHost.phase.installing',
    starting: 'sshHost.phase.starting',
    connected: 'sshHost.phase.connected',
    reconnecting: 'sshHost.phase.reconnecting',
    disconnected: 'sshHost.phase.disconnected',
    stopped: 'sshHost.phase.stopped',
    failed: 'sshHost.phase.failed',
} as const satisfies Record<RemoteConnectionPhase, TranslationKey>;

const failureExplanationKeys = {
    authentication: 'sshHost.failure.authentication',
    hostKey: 'sshHost.failure.hostKey',
    unreachable: 'sshHost.failure.unreachable',
    unsupportedPlatform: 'sshHost.failure.unsupportedPlatform',
    unsupportedGlibc: 'sshHost.failure.unsupportedGlibc',
    missingTool: 'sshHost.failure.missingTool',
    installFailed: 'sshHost.failure.installFailed',
    launchFailed: 'sshHost.failure.launchFailed',
    profileInUse: 'sshHost.failure.profileInUse',
    cancelled: 'sshHost.failure.cancelled',
    connectionLost: 'sshHost.failure.connectionLost',
    unknown: 'sshHost.failure.unknown',
} as const satisfies Record<RemoteFailureReason, TranslationKey>;

/**
 * Phases that are still working toward a connection, which the overlay marks with a spinner.
 */
const BUSY_PHASES: ReadonlySet<RemoteConnectionPhase> = new Set([
    'connecting',
    'probing',
    'installing',
    'starting',
    'reconnecting',
]);

export function connectionPhaseLabelKey(phase: RemoteConnectionPhase): TranslationKey {
    return phaseLabelKeys[phase];
}

export function connectionFailureKey(reason: RemoteFailureReason): TranslationKey {
    return failureExplanationKeys[reason];
}

export function isConnectionBusy(phase: RemoteConnectionPhase): boolean {
    return BUSY_PHASES.has(phase);
}

/**
 * The overlay covers the window whenever the Server is not usable, including while a reconnect runs over an already
 * attached Workbench, whose requests would only fail.
 */
export function isConnectionOverlayVisible(state: SshEnvironmentState | undefined): boolean {
    return state !== undefined && state.phase !== 'connected';
}

/**
 * Reconnect is offered only once the connection gave up; while a phase is still running Main is already trying.
 */
export function canReconnect(state: SshEnvironmentState): boolean {
    return state.phase === 'failed' || state.phase === 'disconnected';
}

/**
 * Whole-percent install progress, or `undefined` when there is nothing determinate to show.
 */
export function installProgressPercent(state: SshEnvironmentState): number | undefined {
    if (state.phase !== 'installing' || !state.progress || state.progress.totalBytes <= 0) return;
    const ratio = state.progress.completedBytes / state.progress.totalBytes;
    return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}
