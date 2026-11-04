import { z } from 'zod';

import { configurationSourceSchema as configSourceSchema } from '../configuration/configuration-contract.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * What Main hands the Renderer after the user picked a dianjiang `delegation.jsonc`: the file's name and its bounded
 * text. Main neither parses nor forwards it; the Renderer sends the text to the Server it is connected to through
 * `settings.delegation.import`, so the preview and the apply run against the same profile.
 */
const delegationImportPickSchema = z.strictObject({
    fileName: z.string().min(1).max(255),
    sourceText: configSourceSchema,
});

export type DelegationImportPick = z.infer<typeof delegationImportPickSchema>;

/**
 * The native open dialog for a delegation import. The result is `null` when the user dismissed the dialog.
 */
export const delegationImportDesktopMethods = {
    'delegationImport.pick': {
        ...commandPolicy('desktop', 'write'),
        params: z.object({}).default({}),
        result: delegationImportPickSchema.nullable(),
    },
} as const satisfies Record<string, MethodSpec>;
