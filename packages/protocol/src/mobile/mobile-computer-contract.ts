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
 * The paired computer's own identity as phones see it.
 */
export const mobileComputerMethods = {
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
