import { Buffer } from 'node:buffer';

import {
    decodeHex,
    isHandshakeConfirmationValid,
    mobileClientConfirmationSchema,
    mobilePairingResultSchema,
} from '@caxri/mobile-transport';
import type { CommandDispatcher, CommandExecutionContext, Principal } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type WebSocket from 'ws';

import type { TerminalExecutionPort } from '../../../domains/terminal';
import type { MobileDeviceRegistry } from '../device-registry';
import { shouldCancelDelayedPairing } from './acceptance-pairing-delay';
import type { MobileGatewayDiagnostics, MobileGatewayFailureReason } from './diagnostics';
import type { MobileAppOptions } from './frame-router';
import { MobileGatewayFrameRouter } from './frame-router';
import type { MobileGatewayOptions } from './gateway-options';
import type { GatewaySession } from './gateway-session';

export interface AuthenticateConnectionDependencies {
    context: (session: GatewaySession) => CommandExecutionContext;
    dispatch: CommandDispatcher;
    diagnostics: Pick<
        MobileGatewayDiagnostics,
        'pairingOutcome' | 'request' | 'flushIfDue' | 'terminalResync'
    >;
    now: () => number;
    options: Pick<
        MobileAppOptions,
        | 'agentChatProjectRoot'
        | 'authorizeMethod'
        | 'authorizeSubscription'
        | 'beginConversationSubscription'
    > & {
        logger?: Pick<StructuredLogger, 'write'>;
        matchesSubscriptionEvent: MobileAppOptions['matchesSubscriptionEvent'];
        registry: Pick<MobileDeviceRegistry, 'commitPair' | 'currentPrincipal' | 'markConnected'>;
        terminalExecution?: TerminalExecutionPort;
    };
    random: (bytes: number) => Uint8Array;
    sendSealed: (
        socket: WebSocket,
        session: GatewaySession,
        payload: unknown,
        onSent?: (error?: Error) => void,
    ) => void;
}

/**
 * The gateway options each authenticated connection's frame router uses.
 */
export const connectionOptions = (
    options: MobileGatewayOptions,
): AuthenticateConnectionDependencies['options'] => ({
    authorizeMethod: options.authorizePairedDeviceMethod,
    authorizeSubscription: options.authorizeSubscription,
    beginConversationSubscription: options.beginConversationSubscription,
    agentChatProjectRoot: options.agentChatProjectRoot,
    logger: options.logger,
    matchesSubscriptionEvent: options.matchesSubscriptionEvent,
    registry: options.registry,
    terminalExecution: options.terminalExecution,
});

/**
 * Verifies the client's handshake confirmation, commits a pending pairing or marks a returning device connected, and
 * builds the session's frame router. Returns `undefined` after the caller has already terminated the socket.
 */
export async function authenticateConnection(
    dependencies: AuthenticateConnectionDependencies,
    session: GatewaySession,
    socket: WebSocket,
    raw: unknown,
    isAcceptingMessages: () => boolean,
    terminate: (reason?: MobileGatewayFailureReason) => void,
): Promise<MobileGatewayFrameRouter | undefined> {
    const confirmation = mobileClientConfirmationSchema.parse(raw);
    if (
        confirmation.connectionId !== session.connection.connectionId ||
        !session.valid ||
        !isHandshakeConfirmationValid(
            decodeHex(confirmation.confirmation, 32),
            session.keys,
            'client',
        )
    ) {
        terminate('authenticationFailed');
        return undefined;
    }
    let principal: Principal;
    if (session.mode === 'pair') {
        if (await shouldCancelDelayedPairing(isAcceptingMessages)) return undefined;
        const candidate = session.candidate!;
        await dependencies.options.registry.commitPair(candidate);
        dependencies.diagnostics.pairingOutcome('succeeded');
        principal = dependencies.options.registry.currentPrincipal(
            candidate.deviceId,
            candidate.generation,
        );
        const pairingResult = mobilePairingResultSchema.parse({
            type: 'paired',
            deviceId: candidate.deviceId,
            generation: candidate.generation,
            credential: candidate.credential,
            projectIds: candidate.projectIds,
        });
        dependencies.sendSealed(socket, session, pairingResult);
    } else {
        principal = dependencies.options.registry.currentPrincipal(
            session.deviceId,
            session.generation,
        );
        await dependencies.options.registry.markConnected(session.deviceId, session.generation);
        dependencies.sendSealed(socket, session, {
            type: 'ready',
            deviceId: session.deviceId,
            generation: session.generation,
        });
    }
    session.principal = principal;
    return new MobileGatewayFrameRouter({
        authorizeMethod: dependencies.options.authorizeMethod,
        authorizeSubscription: dependencies.options.authorizeSubscription,
        beginConversationSubscription: dependencies.options.beginConversationSubscription,
        agentChatProjectRoot: dependencies.options.agentChatProjectRoot,
        context: () => dependencies.context(session),
        dispatch: dependencies.dispatch,
        isActive: () => isAcceptingMessages() && !session.revoking && socket.readyState === 1,
        matchesSubscriptionEvent: dependencies.options.matchesSubscriptionEvent,
        now: dependencies.now,
        randomSubscriptionId: () => Buffer.from(dependencies.random(16)).toString('hex'),
        reportRequest: (method) => dependencies.diagnostics.request(method),
        reportHeartbeat: () => dependencies.diagnostics.flushIfDue(),
        reportTerminalResync: (reason) => dependencies.diagnostics.terminalResync(reason),
        reportHumanSteer: (terminalId) =>
            dependencies.options.logger?.write('info', logEventCatalog.terminal.humanSteer, {
                fields: { terminalId, principalKind: 'paired-device' },
            }),
        send: (payload) =>
            new Promise<void>((resolve, reject) => {
                if (!isAcceptingMessages() || session.revoking) {
                    reject(new Error('Mobile session is no longer active'));
                    return;
                }
                dependencies.context(session);
                dependencies.sendSealed(socket, session, payload, (error) => {
                    if (error) reject(error);
                    else resolve();
                });
            }),
        terminate,
        terminalExecution: dependencies.options.terminalExecution,
    });
}
