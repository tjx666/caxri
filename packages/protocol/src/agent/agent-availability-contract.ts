import { z } from 'zod';

import { agentProviderSchema } from './agents.js';

/**
 * Whether each Agent CLI can be found right now, answered without launching any Agent. The Server resolves each
 * provider's configured executable the same way a launch would, so "Not installed" in the New Session and New Terminal
 * menus agrees with what starting that Agent would do. Never carries an executable path.
 */
const providerAvailabilitySchema = z.object({
    kind: agentProviderSchema,
    available: z.boolean(),
});

export const agentAvailabilitySchema = z.object({
    providers: z.array(providerAvailabilitySchema),
});

export type AgentAvailability = z.infer<typeof agentAvailabilitySchema>;
