import type {
    RemoteConnectionPhase,
    RemoteFailureReason,
    SshEnvironmentState,
} from '@caxri/protocol';
import type { TranslationParameters } from '@desktop-shared/i18n/interpolate';

import type { TranslationKey } from '../../i18n';

/**
 * A translation key with the values it interpolates, for copy whose wording depends on state.
 */
export interface ConnectionCopy {
    key: TranslationKey;
    values?: TranslationParameters;
}

type SshFailure = NonNullable<SshEnvironmentState['failure']>;

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
    takenOver: 'sshHost.failure.takenOver',
    cancelled: 'sshHost.failure.cancelled',
    connectionLost: 'sshHost.failure.connectionLost',
    unknown: 'sshHost.failure.unknown',
} as const satisfies Record<RemoteFailureReason, TranslationKey>;

/**
 * Phases in which a connection attempt is running, so the overlay offers Cancel.
 */
const CANCELLABLE_PHASES: ReadonlySet<RemoteConnectionPhase> = new Set([
    'connecting',
    'probing',
    'installing',
    'starting',
    'reconnecting',
]);

/**
 * Phases that are still working, which the overlay marks with a spinner. `stopped` is set when Stop Server begins and
 * the window closes once the Server has stopped, so while it shows, the stop is still in progress.
 */
const BUSY_PHASES: ReadonlySet<RemoteConnectionPhase> = new Set([...CANCELLABLE_PHASES, 'stopped']);

/**
 * Failures that reconnecting cannot fix because the SSH Host itself has to change first, so Close Window is the only
 * action left.
 */
const HOST_REQUIREMENT_REASONS: ReadonlySet<RemoteFailureReason> = new Set([
    'unsupportedPlatform',
    'unsupportedGlibc',
    'missingTool',
]);

/**
 * The overlay's status line: the phase, except that a cancelled attempt says so rather than "Unable to connect", and a
 * reconnect names which automatic attempt is running.
 */
export function connectionPhaseLabel(state: SshEnvironmentState): ConnectionCopy {
    if (state.phase === 'failed' && state.failure?.reason === 'cancelled')
        return { key: 'sshHost.phase.cancelled' };
    if (state.phase === 'reconnecting' && state.attempt !== undefined)
        return { key: 'sshHost.phase.reconnectingAttempt', values: { attempt: state.attempt } };
    return { key: phaseLabelKeys[state.phase] };
}

export function connectionFailureCopy(failure: SshFailure): ConnectionCopy {
    if (failure.reason === 'profileInUse' && failure.holder)
        return { key: 'sshHost.failure.profileInUseHost', values: { hostname: failure.holder } };
    return { key: failureExplanationKeys[failure.reason] };
}

/**
 * OpenSSH's or the SSH Host's own words for a failure, shown under the explanation and copied by Copy Details. A cancel
 * has none worth showing: the user just did it.
 */
export function connectionFailureDetail(failure: SshFailure | undefined): string | undefined {
    if (!failure || failure.reason === 'cancelled') return undefined;
    return failure.message || undefined;
}

/**
 * The semantic tone of the failure explanation. A cancel is the user's own choice and a takeover is another window
 * doing its job, so neither reads as an error; a cause shown while automatic reconnection keeps trying is a warning.
 */
export function connectionFailureTone(state: SshEnvironmentState): 'danger' | 'muted' | 'warning' {
    const reason = state.failure?.reason;
    if (reason === 'cancelled') return 'muted';
    if (reason === 'takenOver' || state.phase === 'reconnecting') return 'warning';
    return 'danger';
}

/**
 * The command that removes the SSH Host's stale `known_hosts` entry after a host-key failure, quoted for a POSIX shell
 * so a bracketed `[host]:port` is not read as a glob. Main supplies the name only for `hostKey` failures.
 */
export function hostKeyResetCommand(failure: SshFailure | undefined): string | undefined {
    if (failure?.reason !== 'hostKey' || !failure.knownHostsName) return undefined;
    return `ssh-keygen -R '${failure.knownHostsName.replaceAll("'", String.raw`'\''`)}'`;
}

export function isConnectionBusy(phase: RemoteConnectionPhase): boolean {
    return BUSY_PHASES.has(phase);
}

/**
 * Cancel is offered while an attempt runs; it stops that attempt and leaves the window on a `cancelled` failure.
 */
export function canCancelConnection(state: SshEnvironmentState): boolean {
    return CANCELLABLE_PHASES.has(state.phase);
}

/**
 * The phases in which the connection gave up, where focus moves to the overlay's primary action.
 */
export function isConnectionSettled(phase: RemoteConnectionPhase): boolean {
    return phase === 'failed' || phase === 'disconnected';
}

/**
 * The overlay covers the window whenever the Server is not usable, including while a reconnect runs over an already
 * attached Workbench, whose requests would only fail.
 */
export function isConnectionOverlayVisible(state: SshEnvironmentState | undefined): boolean {
    return state !== undefined && state.phase !== 'connected';
}

/**
 * Reconnect is offered only once the connection gave up; while a phase is still running Main is already trying. A host
 * that does not meet Caxri Server's requirements fails the same way on every try, so it gets no Reconnect.
 */
export function canReconnect(state: SshEnvironmentState): boolean {
    if (!isConnectionSettled(state.phase)) return false;
    return !(state.failure && HOST_REQUIREMENT_REASONS.has(state.failure.reason));
}

/**
 * The Reconnect button's label: after another Desktop took the Server over, reconnecting takes it back from that
 * window.
 */
export function reconnectLabelKey(state: SshEnvironmentState): TranslationKey {
    return state.failure?.reason === 'takenOver' ? 'sshHost.useHere' : 'sshHost.reconnect';
}

/**
 * Whole-percent install progress, or `undefined` when there is nothing determinate to show.
 */
export function installProgressPercent(state: SshEnvironmentState): number | undefined {
    if (state.phase !== 'installing' || !state.progress || state.progress.totalBytes <= 0) return;
    const ratio = state.progress.completedBytes / state.progress.totalBytes;
    return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}
