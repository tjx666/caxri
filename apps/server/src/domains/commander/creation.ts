import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentEnvironment } from '../agents';
import { listExternalConversations, probeOpenCodexSessionIds } from '../agents';
import type { CaxriDatabase } from '../db';
import { createCommanderCompletionNotifier } from './completion-notice-delivery';
import { CommanderHandoverService } from './handover';
import type { CommanderInboxServiceOptions } from './inbox';
import { CommanderInboxService } from './inbox';
import type { CommanderTerminalHooks } from './terminal-hooks';

/**
 * Builds the Commander's notifier, inbox, and hand-over service and registers them on its Terminal hooks: lifecycle and
 * input signals reach them through the hooks, and each queues its content-free notices on the notifier.
 */
export function createCommanderServices({
    database,
    environment,
    hooks,
    logger,
    resolveProjectRoot,
    sendFullStateChange,
    ...options
}: Parameters<typeof createCommanderCompletionNotifier>[0] &
    Omit<CommanderInboxServiceOptions, 'database' | 'logger' | 'notify' | 'now'> & {
        database: CaxriDatabase;
        environment: AgentEnvironment;
        hooks: CommanderTerminalHooks;
        logger: StructuredLogger;
        resolveProjectRoot: (path: string) => Promise<string>;
        sendFullStateChange: () => void;
    }): { inbox: CommanderInboxService; handovers: CommanderHandoverService } {
    /**
     * Constructed only once the exact-launch write path it fences against exists.
     */
    hooks.notifier = createCommanderCompletionNotifier({ ...options, database, logger });
    const inbox = new CommanderInboxService({
        ...options,
        database,
        logger,
        notify: (itemId, event) => hooks.notifier?.notifyInbox(itemId, event),
    });
    inbox.start();
    hooks.handovers = new CommanderHandoverService({
        database,
        discoverConversations: (bound) =>
            listExternalConversations({
                environment,
                now: Date.now(),
                excludeProviderSessionIds: bound,
                /**
                 * An idle Codex CLI stops writing its rollout but keeps it open, so only the open-file probe can tell
                 * the picker that a conversation is still live in another terminal. A failed probe falls back to the
                 * mtime heuristic and logs only its closed reason.
                 */
                openCodexSessionIds: async () => {
                    const started = performance.now();
                    const probe = await probeOpenCodexSessionIds(environment);
                    if (probe.ok) return probe.sessionIds;
                    logger.write('warn', logEventCatalog.agentCommander.codexOpenProbeFailed, {
                        durationMs: Math.round(performance.now() - started),
                        fields: { reason: probe.reason },
                    });
                    return;
                },
            }),
        logger,
        notify: (entry) => hooks.notifier?.notifyHandover(entry),
        resolveProjectRoot,
        sendFullStateChange,
    });
    return { inbox, handovers: hooks.handovers };
}
