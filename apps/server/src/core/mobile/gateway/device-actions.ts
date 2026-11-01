import type { DeviceAction, DeviceActionOutcome, DeviceActionRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { GatewaySession } from './gateway-session';

/**
 * Extra time Server Core waits past the command's own deadline, so the phone's `timeout` answer normally arrives first
 * and names the cause.
 */
const ANSWER_GRACE_MS = 5_000;
/**
 * How long an `openUrl` may take to be acknowledged. Opening a link is immediate on a listening phone.
 */
const OPEN_URL_ANSWER_MS = 15_000;
const MAXIMUM_PENDING_ACTIONS = 16;

/**
 * One connected phone that holds an acknowledged `deviceActions` subscription.
 */
export interface DeviceActionListener {
    connectionId: string;
    deviceId: string;
    deliver: (request: DeviceActionRequest) => boolean;
}

/**
 * Every live, non-revoking socket whose phone acknowledged a `deviceActions` subscription.
 */
export const deviceActionListeners = (
    activeByDevice: ReadonlyMap<string, ReadonlyMap<unknown, GatewaySession>>,
): DeviceActionListener[] =>
    activeByDevice
        .entries()
        .flatMap(([deviceId, sockets]) =>
            sockets.values().flatMap((session): DeviceActionListener[] => {
                const { application } = session;
                if (session.revoking || !application?.acceptsDeviceActions()) return [];
                return [
                    {
                        connectionId: session.connection.connectionId,
                        deviceId,
                        deliver: (request) => application.deliverDeviceAction(request),
                    },
                ];
            }),
        )
        .toArray();

interface PendingAction {
    connectionId: string;
    deviceId: string;
    kind: DeviceAction['kind'];
    reject: (error: Error) => void;
    resolve: (outcome: DeviceActionOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * Why a requested action ended without the phone's outcome. A closed set for `mobile_gateway.device_action`.
 */
type DeviceActionDrop = 'no-listener' | 'ambiguous-target' | 'disconnected' | 'answer-timeout';

/**
 * Records one finished action: its kind, how it ended, how long it took, and the phone's failure reason when it gave
 * one. Never the URL, the command, or its output.
 */
export type DeviceActionReport = (
    kind: DeviceAction['kind'],
    outcome: DeviceActionOutcome['status'] | DeviceActionDrop,
    durationMs: number,
    reason?: string,
) => void;

const phoneOfflineError = (deviceId?: string): CaxriError =>
    new CaxriError(
        'UNAVAILABLE',
        deviceId
            ? 'That phone is not connected to Caxri right now'
            : 'No paired phone is connected to Caxri right now',
        { reason: 'offline' },
    );

/**
 * Pairs each pushed action with the phone's later `mobile.deviceAction.complete`. Nothing is queued for a phone that is
 * not listening, and an action whose connection closes fails at once, because a reconnecting phone has no record of it
 * and a CLI caller would otherwise wait out the whole deadline.
 */
export class DeviceActionBroker {
    readonly #pending = new Map<string, PendingAction>();
    readonly #listeners: () => readonly DeviceActionListener[];
    readonly #randomId: () => string;
    readonly #report?: DeviceActionReport;
    readonly #now: () => number;

    constructor(options: {
        listeners: () => readonly DeviceActionListener[];
        now: () => number;
        randomId: () => string;
        report?: DeviceActionReport;
    }) {
        this.#listeners = options.listeners;
        this.#now = options.now;
        this.#randomId = options.randomId;
        this.#report = options.report;
    }

    #target(
        deviceId: string | undefined,
        kind: DeviceAction['kind'],
        startedAt: number,
    ): DeviceActionListener {
        const listeners = this.#listeners().filter(
            (listener) => deviceId === undefined || listener.deviceId === deviceId,
        );
        const devices = new Set(listeners.map((listener) => listener.deviceId));
        if (devices.size === 0) {
            this.#report?.(kind, 'no-listener', this.#now() - startedAt);
            throw phoneOfflineError(deviceId);
        }
        if (devices.size > 1) {
            this.#report?.(kind, 'ambiguous-target', this.#now() - startedAt);
            throw new CaxriError(
                'VALIDATION',
                'Several phones are connected; choose one with --device',
                { reason: 'ambiguous-target', deviceIds: [...devices] },
            );
        }
        // A phone with two live sockets (a reconnect overlapping its old one) answers on the newest.
        return listeners.at(-1) as DeviceActionListener;
    }

    /**
     * Device IDs that can take an action right now.
     */
    onlineDeviceIds(): Set<string> {
        return new Set(this.#listeners().map((listener) => listener.deviceId));
    }

    request(
        deviceId: string | undefined,
        action: DeviceAction,
    ): Promise<{ deviceId: string; outcome: DeviceActionOutcome }> {
        if (this.#pending.size >= MAXIMUM_PENDING_ACTIONS)
            throw new CaxriError('CAPACITY', 'Too many phone actions are in flight');
        const startedAt = this.#now();
        const listener = this.#target(deviceId, action.kind, startedAt);
        const actionId = `action_${this.#randomId()}`;
        const waitMs =
            action.kind === 'termuxExec' ? action.timeoutMs + ANSWER_GRACE_MS : OPEN_URL_ANSWER_MS;
        return new Promise((resolve, reject) => {
            const settle = (
                outcome: DeviceActionOutcome['status'] | DeviceActionDrop,
                reason?: string,
            ) => {
                const pending = this.#pending.get(actionId);
                if (!pending) return false;
                this.#pending.delete(actionId);
                clearTimeout(pending.timer);
                this.#report?.(action.kind, outcome, this.#now() - startedAt, reason);
                return true;
            };
            const timer = setTimeout(() => {
                if (settle('answer-timeout'))
                    reject(
                        new CaxriError('TIMEOUT', 'The phone did not answer in time', {
                            reason: 'timeout',
                        }),
                    );
            }, waitMs);
            timer.unref();
            this.#pending.set(actionId, {
                connectionId: listener.connectionId,
                deviceId: listener.deviceId,
                kind: action.kind,
                reject: (error) => {
                    if (settle('disconnected')) reject(error);
                },
                resolve: (outcome) => {
                    if (
                        settle(
                            outcome.status,
                            outcome.status === 'failed' ? outcome.reason : undefined,
                        )
                    )
                        resolve({ deviceId: listener.deviceId, outcome });
                },
                timer,
            });
            if (!listener.deliver({ actionId, action })) {
                const pending = this.#pending.get(actionId);
                pending?.reject(phoneOfflineError());
            }
        });
    }

    /**
     * Accepts the phone's answer. An answer from another device, or for an action that already timed out, is ignored:
     * the requester has moved on, and the phone cannot learn more by being told.
     */
    complete(deviceId: string, actionId: string, outcome: DeviceActionOutcome): void {
        const pending = this.#pending.get(actionId);
        if (pending?.deviceId !== deviceId) return;
        pending.resolve(outcome);
    }

    connectionClosed(connectionId: string): void {
        for (const pending of this.#pending.values())
            if (pending.connectionId === connectionId) pending.reject(phoneOfflineError());
    }

    close(): void {
        for (const pending of this.#pending.values()) pending.reject(phoneOfflineError());
    }
}
