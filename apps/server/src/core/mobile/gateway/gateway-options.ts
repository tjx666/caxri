import type { Socket } from 'node:net';

import type { MobileSubscriptionResource } from '@caxri/mobile-transport';
import type { CommandDispatcherOptions, Principal, ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { TerminalExecutionPort } from '../../../domains/terminal';
import type { MobileDeviceRegistry } from '../device-registry';
import type { MobileUpdateSource } from '../update-bundle';
import type { MobileAppOptions } from './frame-router';

export interface MobileGatewayOptions {
    logger?: Pick<StructuredLogger, 'write'>;
    adapters: CommandDispatcherOptions;
    authorizePairedDeviceMethod: (principal: Principal, method: string) => void;
    authorizeSubscription: (
        principal: Principal,
        resource: MobileSubscriptionResource,
    ) => Promise<void>;
    beginConversationSubscription?: MobileAppOptions['beginConversationSubscription'];
    beginAgentChatSubscription?: MobileAppOptions['beginAgentChatSubscription'];
    agentChatProjectRoot?: MobileAppOptions['agentChatProjectRoot'];
    bootId: string;
    now?: () => number;
    protocolIdentity: { serverId: string; stateEpoch: string };
    random?: (bytes: number) => Uint8Array;
    registry: MobileDeviceRegistry;
    matchesSubscriptionEvent: (
        principal: Principal,
        resource: MobileSubscriptionResource,
        event: ServerEvent,
    ) => Promise<boolean>;
    /**
     * Reports the current count of authenticated ("ready") Mobile connections whenever it changes, so a caller can fold
     * it into a broader idle-exit or diagnostics signal alongside `ControlServer`'s own client count. Fires with the
     * new total, never per-socket detail.
     */
    onConnectionCountChanged?: (count: number) => void;
    terminalExecution?: TerminalExecutionPort;
    /**
     * Peer address override for loopback tests.
     */
    sourceAddress?: (socket: Socket) => string | undefined;
    /**
     * Test seam; production always selects one private IPv4 interface.
     */
    selectAddress?: () => string;
    /**
     * Test seam for driving a real handshake timeout without a 10-second wait; production always uses the default.
     */
    handshakeTimeoutMs?: number;
    /**
     * The Android bundle shipped with this Desktop, read directly by update recovery so that path never enters the
     * command dispatcher. Absent means recovery answers "no bundle".
     */
    updateSource?: () => Promise<MobileUpdateSource | undefined>;
}
