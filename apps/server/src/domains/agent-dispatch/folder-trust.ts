import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentEnvironment } from '../agents';
import {
    grantAntigravityFolderTrust,
    grantClaudeFolderTrust,
    grantGrokFolderTrust,
} from '../agents';
import type { AgentDispatchServiceOptions } from './service-options';

/**
 * The dispatch `prepareLaunch` hook that pre-trusts a dispatched Agent's working directory for the providers whose
 * Terminal asks first. Claude Code asks whether to trust a folder it has never opened even under
 * `--dangerously-skip-permissions`, `agy` asks the same before its first turn, and Grok Build asks for every folder it
 * has not seen, including each new linked worktree of a trusted repository; any of them would hold a delegated task at
 * startup until the user answered in its Terminal. The directory was already validated against the Session's authorized
 * Project roots, so the user explicitly added it. Other providers take their trust elsewhere.
 */
export function folderTrustPreparer(
    environment: AgentEnvironment,
    logger: StructuredLogger,
): NonNullable<AgentDispatchServiceOptions['prepareLaunch']> {
    return async (provider, cwd) => {
        let outcome: string;
        switch (provider) {
            case 'claude': {
                outcome = await grantClaudeFolderTrust(environment, [cwd]);
                break;
            }
            case 'antigravity': {
                outcome = await grantAntigravityFolderTrust(environment, cwd);
                break;
            }
            case 'grok': {
                outcome = await grantGrokFolderTrust(environment, cwd);
                break;
            }
            default:
                return;
        }
        logger.write(
            outcome === 'granted' || outcome === 'already_trusted' ? 'debug' : 'warn',
            logEventCatalog.agentDispatch.folderTrustPrepared,
            { fields: { provider, outcome } },
        );
    };
}
