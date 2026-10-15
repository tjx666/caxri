import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
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
    t: Translate = translate,
): { message: string; isError: boolean } | null => {
    switch (delivery.kind) {
        case 'sending':
            return { message: t('sessions.composer.sending'), isError: false };
        case 'accepted':
            return { message: t('sessions.composer.delivered'), isError: false };
        case 'failed':
        case 'stop-failed':
            return { message: delivery.message, isError: true };
        case 'unknown':
            return {
                message: t('sessions.composer.deliveryUnknown'),
                isError: true,
            };
        case 'stopping':
            return { message: t('sessions.composer.stopping'), isError: false };
        case 'stopped':
            return { message: t('sessions.composer.stopSent'), isError: false };
        case 'stop-unknown':
            return {
                message: t('sessions.composer.stopUnknown'),
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

export const composerTextError = (
    draft: string,
    maxBytes: number,
    t: Translate = translate,
): string | null => {
    if (draft.trim().length === 0) return t('sessions.composer.emptyDraft');
    if (hasInvalidControlCharacter(draft)) return t('sessions.composer.controlCharacters');
    if (composerByteLength(draft) > maxBytes)
        return t('sessions.composer.tooLong', { size: formatByteSize(maxBytes) });
    return null;
};

export const composerDisabledReason = (
    session: MobileSessionItem,
    isConnected: boolean,
    deviceRole: 'view' | 'reply' | 'control' | null,
    t: Translate = translate,
): string | null => {
    if (!isConnected) return t('sessions.composer.reconnectToSend');
    if (deviceRole !== 'reply' && deviceRole !== 'control') return t('sessions.composer.viewOnly');
    if (!session.primaryAgentTerminalId || !session.primaryTerminal)
        return t('sessions.composer.noPrimaryAgent');
    if (session.primaryTerminal.lastProcessState !== 'running')
        return t('sessions.composer.agentNotRunning');
    if (!session.primaryAgentEndpoint) return t('sessions.composer.targetUnavailable');
    return null;
};

export const stopDisabledReason = (
    session: MobileSessionItem,
    isConnected: boolean,
    deviceRole: 'view' | 'reply' | 'control' | null,
    t: Translate = translate,
): string | null => {
    if (!isConnected) return t('sessions.composer.reconnectToStop');
    if (deviceRole !== 'control') return t('sessions.composer.stopNeedsControl');
    if (!session.primaryAgentEndpoint || !session.primaryAgentTerminalId)
        return t('sessions.composer.targetUnavailable');
    if (session.primaryTerminal?.lastProcessState !== 'running')
        return t('sessions.composer.agentNotRunning');
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
