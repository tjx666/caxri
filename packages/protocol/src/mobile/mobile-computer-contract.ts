import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * `null` (or an empty name) restores the system host name. The Settings schema owns the length and character rules, so
 * this shape stays loose enough for the Server to answer a too-long or control-character name with a validation error.
 */
const mobileComputerRenameParametersSchema = z.strictObject({
    name: z.string().max(200).nullable(),
});

const mobileComputerRenameResultSchema = z.strictObject({
    hostDisplayName: z.string().trim().min(1).max(100),
});

/**
 * The direct endpoints this computer listens on right now: its private LAN and Tailscale IPv4 addresses, best first,
 * and the gateway port. The phone validates each address against its own private-network rules before dialing one.
 */
const mobileComputerRoutesResultSchema = z.strictObject({
    addresses: z.array(z.ipv4()).min(1).max(8),
    port: z.number().int().min(1).max(65_535),
});

/**
 * The paired computer's own identity as phones see it.
 */
export const mobileComputerMethods = {
    /**
     * A pairing link carries the addresses the computer had at pairing time, which go stale once it joins another
     * network. Every role reads the current ones after connecting (over the Relay too), so a direct path works again
     * without pairing anew. It reveals only this computer's private addresses, which the pairing link already did.
     */
    'mobile.computer.routes': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({}).default({}),
        result: mobileComputerRoutesResultSchema,
    },
    /**
     * Renames this computer for every paired phone by writing `mobile.computerName`. It carries `projects.write`, the
     * grant that already arranges this computer's Projects, rather than `settings.write`, which no phone holds; the
     * role allowlist confines it to control devices.
     */
    'mobile.computer.rename': {
        ...commandPolicy('server', 'write', ['projects.write']),
        params: mobileComputerRenameParametersSchema,
        result: mobileComputerRenameResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;
