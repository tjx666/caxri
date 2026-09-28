import { formatByteSize } from '../../lib/format-size';
import { notifyListeners } from '../../lib/notify-listeners';
import type { MobileSessionItem } from './session-model';

type PrimaryAgentEndpoint = NonNullable<MobileSessionItem['primaryAgentEndpoint']>;

export type ComposerDelivery =
    | { kind: 'idle' }
    | { kind: 'sending'; mutationId: string; text: string }
    | { kind: 'accepted'; mutationId: string }
    | { kind: 'failed'; message: string }
    | { kind: 'unknown'; mutationId: string; text: string }
    | { kind: 'stopping'; endpoint: PrimaryAgentEndpoint }
    | { kind: 'stopped' }
    | { kind: 'stop-failed'; message: string }
    | { kind: 'stop-unknown' };

const idleDelivery: ComposerDelivery = { kind: 'idle' };
const textEncoder = new TextEncoder();

const hasInvalidControlCharacter = (text: string): boolean => {
    for (const character of text) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined) continue;
        if (
            (codePoint >= 127 && codePoint <= 159) ||
            (codePoint < 32 && ![9, 10].includes(codePoint))
        )
            return true;
    }
    return false;
};

export const composerByteLength = (draft: string): number => textEncoder.encode(draft).byteLength;

/**
 * An explicit retry of an unconfirmed write must ask the Server about the same attempt.
 */
export const composerMutationIdForAttempt = (
    delivery: ComposerDelivery,
    draft: string,
    createMutationId: () => string,
): string =>
    delivery.kind === 'unknown' && delivery.text === draft
        ? delivery.mutationId
        : createMutationId();

export const composerDeliveryFeedback = (
    delivery: ComposerDelivery,
): { message: string; isError: boolean } | null => {
    switch (delivery.kind) {
        case 'sending':
            return { message: 'Sending…', isError: false };
        case 'accepted':
            return { message: 'Delivered to the Terminal.', isError: false };
        case 'failed':
        case 'stop-failed':
            return { message: delivery.message, isError: true };
        case 'unknown':
            return {
                message: "Couldn't confirm delivery. Check the Terminal before sending again.",
                isError: true,
            };
        case 'stopping':
            return { message: 'Stopping Agent…', isError: false };
        case 'stopped':
            return { message: 'Stop signal sent.', isError: false };
        case 'stop-unknown':
            return {
                message: "Couldn't confirm whether the Agent stopped. Check the Terminal.",
                isError: true,
            };
        case 'idle':
            return null;
    }
};

const hasStopTargetChanged = (
    expected: PrimaryAgentEndpoint,
    current: PrimaryAgentEndpoint | undefined,
): boolean =>
    !current ||
    expected.hostId !== current.hostId ||
    expected.endpointId !== current.endpointId ||
    expected.generation !== current.generation;

/**
 * An interrupt acknowledges a signal, not completion. Wait for the Agent activity to leave running, the target to
 * change, or the Terminal process to stop before reporting that the current turn stopped.
 */
export const reconcileStopWithSession = (
    delivery: ComposerDelivery,
    currentEndpoint: PrimaryAgentEndpoint | undefined,
    terminalProcessState:
        NonNullable<MobileSessionItem['primaryTerminal']>['lastProcessState'] | undefined,
    lastActivityState: MobileSessionItem['lastActivityState'],
): ComposerDelivery =>
    delivery.kind === 'stopping' &&
    (lastActivityState !== 'running' ||
        terminalProcessState !== 'running' ||
        hasStopTargetChanged(delivery.endpoint, currentEndpoint))
        ? { kind: 'stopped' }
        : delivery;

export const composerTextError = (draft: string, maxBytes: number): string | null => {
    if (draft.trim().length === 0) return 'Write a message to send.';
    if (hasInvalidControlCharacter(draft)) return 'Remove control characters before sending.';
    if (composerByteLength(draft) > maxBytes)
        return `Messages can be at most ${formatByteSize(maxBytes)}.`;
    return null;
};

export const composerDisabledReason = (
    session: MobileSessionItem,
    isConnected: boolean,
    deviceRole: 'view' | 'reply' | 'control' | null,
): string | null => {
    if (!isConnected) return 'Reconnect to Caxri before sending.';
    if (deviceRole !== 'reply' && deviceRole !== 'control')
        return 'This device can only view Sessions.';
    if (!session.primaryAgentTerminalId || !session.primaryTerminal)
        return 'This Session has no available primary Agent.';
    if (session.primaryTerminal.lastProcessState !== 'running')
        return 'The primary Agent is not running.';
    if (!session.primaryAgentEndpoint)
        return 'The current Agent target is unavailable. Refresh the Session.';
    return null;
};

export const stopDisabledReason = (
    session: MobileSessionItem,
    isConnected: boolean,
    deviceRole: 'view' | 'reply' | 'control' | null,
): string | null => {
    if (!isConnected) return 'Reconnect to Caxri before stopping the Agent.';
    if (deviceRole !== 'control') return 'Control access is required to stop the Agent.';
    if (!session.primaryAgentEndpoint || !session.primaryAgentTerminalId)
        return 'The current Agent target is unavailable. Refresh the Session.';
    if (session.primaryTerminal?.lastProcessState !== 'running')
        return 'The primary Agent is not running.';
    return null;
};

/**
 * Delivery state lives for the app session, independent of a screen mount. A pending request can finish after the user
 * navigates away, and an uncertain request must remain visible when they return.
 */
export class SessionComposerDeliveryStore {
    readonly #states = new Map<string, ComposerDelivery>();
    readonly #listeners = new Map<string, Set<() => void>>();

    get(key: string): ComposerDelivery {
        return this.#states.get(key) ?? idleDelivery;
    }

    set(key: string, state: ComposerDelivery): void {
        this.#states.set(key, state);
        const listeners = this.#listeners.get(key) ?? [];
        // Isolates each composer subscriber so one throwing screen cannot stop the rest from observing this delivery
        // state. Mobile has no structured-log sink to report into yet, so the failure is isolated silently.
        notifyListeners(listeners, undefined);
    }

    subscribe(key: string, listener: () => void): () => void {
        const listeners = this.#listeners.get(key) ?? new Set<() => void>();
        listeners.add(listener);
        this.#listeners.set(key, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.#listeners.delete(key);
        };
    }
}

export const sessionComposerDeliveryStore = new SessionComposerDeliveryStore();
