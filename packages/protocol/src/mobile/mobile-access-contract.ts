import { z } from 'zod';

/**
 * Why the Server's outbound Relay registration last went offline. A closed enum that mirrors the `cause` of the offline
 * `mobile_gateway.relay_state` log event, so Settings can name the reason without free text, and never carries the
 * Relay address or any credential.
 */
export const mobileRelayFailureSchema = z.enum([
    'closed-by-relay',
    'heartbeat-timeout',
    'network-error',
    'protocol-error',
    'registration-rejected',
]);

export type MobileRelayFailure = z.infer<typeof mobileRelayFailureSchema>;

/**
 * Desktop-facing state of Mobile access: the LAN listener, paired and pending counts, and the optional Relay route.
 */
export const mobileAccessStatusSchema = z.strictObject({
    enabled: z.boolean(),
    address: z.ipv4().optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    pairedDeviceCount: z.number().int().nonnegative().max(128),
    pendingPairingCount: z.number().int().nonnegative().max(8),
    /**
     * Present while a Relay URL is configured and access is on: whether the Server's outbound Relay registration is
     * live, and the host ID phones address it by.
     */
    relay: z
        .strictObject({
            state: z.enum(['connecting', 'online', 'offline']),
            /**
             * Present until the registration succeeds, including while the next attempt is `connecting`.
             */
            lastFailure: mobileRelayFailureSchema.optional(),
            hostId: z.string().regex(/^[0-9a-f]{32}$/u),
        })
        .optional(),
});

export type MobileAccessStatus = z.infer<typeof mobileAccessStatusSchema>;
