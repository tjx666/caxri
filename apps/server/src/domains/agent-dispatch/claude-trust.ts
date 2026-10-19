import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentEnvironment } from '../agents';
import { grantClaudeFolderTrust } from '../agents';
import type { AgentDispatchServiceOptions } from './service-options';

/**
 * The dispatch `prepareLaunch` hook that pre-trusts a dispatched Claude Code's working directory. Claude Code asks
 * whether to trust a folder it has never opened even under `--dangerously-skip-permissions`, which would hold a
 * delegated task at startup until the user answered in its Terminal. The directory was already validated against the
 * Session's authorized Project roots, so the user explicitly added it. Other providers take their trust elsewhere.
 */
export function claudeTrustPreparer(
    environment: AgentEnvironment,
    logger: StructuredLogger,
): NonNullable<AgentDispatchServiceOptions['prepareLaunch']> {
    return async (provider, cwd) => {
        if (provider !== 'claude') return;
        const outcome = await grantClaudeFolderTrust(environment, [cwd]);
        logger.write(
            outcome === 'granted' || outcome === 'already_trusted' ? 'debug' : 'warn',
            logEventCatalog.agentDispatch.claudeTrustPrepared,
            { fields: { outcome } },
        );
    };
}
