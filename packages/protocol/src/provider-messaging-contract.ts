import { z } from 'zod';

import { agentEndpointSummarySchema } from './agent-endpoint-contract.js';
import { agentInboundMessageSchema } from './agent-inbox-contract.js';
import { identifierSchema } from './domain.js';

export const providerMessagingRegistrationSchema = z
    .object({
        endpoint: agentEndpointSummarySchema,
        adapterId: identifierSchema,
        adapterVersion: z.string().trim().min(1).max(200),
    })
    .strict();

export const providerMessageDeliverySchema = z
    .object({
        deliveryId: identifierSchema,
        message: agentInboundMessageSchema,
    })
    .strict();

export const providerMessageAckSchema = z
    .object({
        deliveryId: identifierSchema,
        outcome: z.enum(['accepted', 'retry', 'unavailable']),
    })
    .strict();

export type ProviderMessagingRegistration = z.infer<typeof providerMessagingRegistrationSchema>;
export type ProviderMessageDelivery = z.infer<typeof providerMessageDeliverySchema>;
export type ProviderMessageAck = z.infer<typeof providerMessageAckSchema>;

/** Host-side boundary for a documented Provider channel. Returning is the explicit ack boundary. */
export interface ProviderMessagingAdapter {
    deliver(delivery: ProviderMessageDelivery): Promise<ProviderMessageAck>;
    revoke(): void | Promise<void>;
}
