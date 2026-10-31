import { z } from 'zod';

import { agentProviderSchema } from './agents.js';

/**
 * Whether each Agent CLI can be found right now, answered without launching any Agent. The Server resolves each
 * provider's configured executable the same way a launch would, so "Not installed" in the New Session and New Terminal
 * menus agrees with what starting that Agent would do. Never carries an executable path or account details.
 */
const providerAvailabilitySchema = z.object({
    kind: agentProviderSchema,
    available: z.boolean(),
    /**
     * True only when the installed CLI's own status command reported that it is signed out (`claude auth status`,
     * `codex login status`). Absent when it is signed in, when the provider has no status command (Grok Build,
     * Antigravity), or when the check failed or timed out: the menus never claim a sign-in problem on no evidence.
     */
    needsSignIn: z.boolean().optional(),
});

export const agentAvailabilitySchema = z.object({
    providers: z.array(providerAvailabilitySchema),
});

export type AgentAvailability = z.infer<typeof agentAvailabilitySchema>;
