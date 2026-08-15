import { createHash, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';

import type { CommandDispatcherOptions } from '../shared/ipc/dispatcher';
import type { CaxriError } from '../shared/ipc/errors';
import { toWireError } from '../shared/ipc/errors';
import type {
    DesktopLease,
    DesktopTargetPayload,
    HostDesktopCredential,
    HostManifest,
    LocalClientCommand,
    LocalServerReply,
} from '../shared/ipc/local-transport';
import type { RuntimeRequest } from '../shared/ipc/methods';
import type { CommandExecutionContext } from '../shared/ipc/principal';
import type { CommandReplyEnvelope } from '../shared/ipc/transport';
import { CAXRI_PROTOCOL_VERSION } from '../shared/ipc/version';

export const MAX_IN_FLIGHT_REQUESTS = 64;
/**
Reserve a small bounded lane so a busy Desktop cannot starve interactive PTY traffic.
 */
export const MAX_NON_TERMINAL_IN_FLIGHT_REQUESTS = 48;
export const HANDSHAKE_TIMEOUT_MS = 2_000;
export const DESKTOP_LEASE_MS = 60_000;
export const DESKTOP_COMMAND_TIMEOUT_MS = 15_000;

export function fileSystemCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

export function isTokenMatch(candidate: string, expected: string): boolean {
    const candidateDigest = createHash('sha256').update(candidate).digest();
    const expectedDigest = createHash('sha256').update(expected).digest();
    return timingSafeEqual(candidateDigest, expectedDigest);
}

export function operatorContext(profileId: string): CommandExecutionContext {
    return {
        capabilities: [
            'desktop.window',
            'diagnostics.read',
            'agents.read',
            'agents.control',
            'agents.dispatch',
            'agents.grant',
            'events.read',
            'host.read',
            'host.stop',
            'projects.read',
            'sessions.read',
            'settings.read',
            'settings.write',
            'terminals.read',
            'terminals.steer',
        ],
        /**
        The authenticated profile is the retry identity across short-lived CLI connections.
         */
        principal: { kind: 'human-cli', id: `human-cli:${profileId}` },
    };
}

export async function executeReply(
    id: string,
    action: () => Promise<unknown>,
): Promise<CommandReplyEnvelope> {
    try {
        return {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id,
            ok: true,
            result: await action(),
        };
    } catch (error) {
        return {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id,
            ok: false,
            error: toWireError(error),
        };
    }
}

export interface ClientState {
    closed: boolean;
    context: CommandExecutionContext;
    desktopLease?: DesktopLease;
    desktopReady: boolean;
    inFlightRequestIds: Map<string, number>;
    inFlightRequests: number;
    inFlightTerminalRequests: number;
    leaseTimer?: NodeJS.Timeout;
    socket: Socket;
}

export interface PendingDesktopCommand {
    reject(error: CaxriError): void;
    resolve(value: unknown): void;
    state: ClientState;
    timer: NodeJS.Timeout;
}

export interface DesktopLeaseWaiter {
    reject(error: CaxriError): void;
    resolve(lease: DesktopLease): void;
    timer: NodeJS.Timeout;
}

export interface LocalHostServerOptions {
    adapters: CommandDispatcherOptions;
    authenticateAgent?(credential: {
        hostId: string;
        endpointId: string;
        generation: number;
        token: string;
    }): CommandExecutionContext;
    consumeDesktopTarget?(targetId: string, generation: number): Promise<DesktopTargetPayload>;
    desktopCredential: HostDesktopCredential;
    /**
    Test seam for exercising lease expiry without a minute-long integration test.
     */
    desktopLeaseDurationMs?: number;
    invokeDesktopRuntime?(request: RuntimeRequest): Promise<unknown>;
    manifest: HostManifest;
    onClientCountChanged?(count: number): void;
    onDesktopUnavailable?(): void;
    onReplyFlushed?(
        request: LocalClientCommand['request'],
        reply: LocalServerReply['reply'],
        context: CommandExecutionContext,
    ): void;
    onRequestDisconnected?(requestId: string, context: CommandExecutionContext): void;
    refreshContext?(context: CommandExecutionContext): CommandExecutionContext;
}
