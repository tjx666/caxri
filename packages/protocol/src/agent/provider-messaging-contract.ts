import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import { agentEndpointSummarySchema } from './agent-endpoint-contract.js';
import { agentInboundMessageSchema } from './agent-inbox-contract.js';

export const providerMessagingRegistrationSchema = z.strictObject({
    endpoint: agentEndpointSummarySchema,
    adapterId: identifierSchema,
    adapterVersion: z.string().trim().min(1).max(200),
});

export const providerMessageDeliverySchema = z.strictObject({
    deliveryId: identifierSchema,
    message: agentInboundMessageSchema,
});

export const providerMessageAckSchema = z.strictObject({
    deliveryId: identifierSchema,
    outcome: z.enum(['accepted', 'retry', 'unavailable']),
});

export type ProviderMessagingRegistration = z.infer<typeof providerMessagingRegistrationSchema>;
type ProviderMessageDelivery = z.infer<typeof providerMessageDeliverySchema>;
export type ProviderMessageAck = z.infer<typeof providerMessageAckSchema>;

/**
 * Host-side boundary for a documented Provider channel. Returning is the explicit ack boundary.
 */
export interface ProviderMessagingAdapter {
    deliver(delivery: ProviderMessageDelivery): Promise<ProviderMessageAck>;
    revoke(): void | Promise<void>;
}
