import { z } from 'zod';

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
            hostId: z.string().regex(/^[0-9a-f]{32}$/u),
        })
        .optional(),
});

export type MobileAccessStatus = z.infer<typeof mobileAccessStatusSchema>;
