import { describe, expect, it } from 'vitest';

import {
    providerMessageAckSchema,
    providerMessageDeliverySchema,
    providerMessagingRegistrationSchema,
} from '../provider-messaging-contract.js';

const endpointSummary = {
    ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
    projectId: 'project-1',
    sessionId: 'session-1',
    terminalId: 'terminal-1',
    provider: 'claude' as const,
    name: 'agent-endpoint',
    permissionClass: 'standard' as const,
    messaging: {
        deliveryMode: 'pull' as const,
        health: 'ready' as const,
        reason: 'pull_ready' as const,
        checkedAt: 1,
        nextAction: 'none' as const,
    },
    expiresAt: 1,
};

describe('providerMessagingRegistrationSchema', () => {
    it('rejects extra fields on this strict registration payload', () => {
        expect(
            providerMessagingRegistrationSchema.safeParse({
                endpoint: endpointSummary,
                adapterId: 'adapter-1',
                adapterVersion: '1.0.0',
                unexpected: 'field',
            }).success,
        ).toBe(false);
    });

    it('accepts a well-formed adapter registration', () => {
        expect(
            providerMessagingRegistrationSchema.safeParse({
                endpoint: endpointSummary,
                adapterId: 'adapter-1',
                adapterVersion: '1.0.0',
            }).success,
        ).toBe(true);
    });
});

describe('providerMessageAckSchema', () => {
    it('restricts the delivery outcome to the closed acknowledgment enum', () => {
        expect(
            providerMessageAckSchema.safeParse({ deliveryId: 'delivery-1', outcome: 'accepted' })
                .success,
        ).toBe(true);
        expect(
            providerMessageAckSchema.safeParse({ deliveryId: 'delivery-1', outcome: 'delivered' })
                .success,
        ).toBe(false);
    });
});

describe('providerMessageDeliverySchema', () => {
    it('carries a full inbound peer message alongside its delivery id', () => {
        const inboundMessage = {
            id: 'message-1',
            origin: 'peer' as const,
            from: endpointSummary,
            to: endpointSummary.ref,
            body: 'peer text',
            createdAt: 1,
            expiresAt: 2,
        };
        expect(
            providerMessageDeliverySchema.safeParse({
                deliveryId: 'delivery-1',
                message: inboundMessage,
            }).success,
        ).toBe(true);
    });
});
