import { z } from 'zod';

import { agentProviderSchema } from '../agent/agents.js';

/**
 * A typed request to open Settings scrolled and focused to one specific row, instead of landing on the tab's default
 * view. A companion window (the Agent Commander) hands this to the Workbench, which owns the only Settings surface; see
 * `docs/agent-commander.md`. Extend this union with a new `kind` for the next specific deep link rather than growing an
 * ad hoc parameter bag on `agentCommander.openSettings` or any other caller.
 */
export const settingsTargetSchema = z.discriminatedUnion('kind', [
    /**
     * The Agent executable row for one provider, offered when its Terminal cannot find that Agent's CLI.
     */
    z.object({
        kind: z.literal('agentExecutable'),
        provider: agentProviderSchema,
    }),
]);

export type SettingsTarget = z.infer<typeof settingsTargetSchema>;
