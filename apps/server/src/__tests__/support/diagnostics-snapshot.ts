import type { diagnosticsSnapshotSchema } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import type { z } from 'zod';

/**
 * A minimal valid `diagnostics.snapshot` result for transport tests that only need the reply to pass result validation.
 */
export function diagnosticsSnapshotFixture(
    overrides: Partial<z.input<typeof diagnosticsSnapshotSchema>> = {},
): z.input<typeof diagnosticsSnapshotSchema> {
    return {
        appVersion: '1.0.0',
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        runtimeStatus: 'ready',
        startedAt: 1,
        activePtyCount: 0,
        projectCount: 0,
        sessionCount: 0,
        terminalCount: 0,
        recentErrorIds: [],
        performance: [],
        caxriBot: {
            state: 'stopped',
            sessionCount: 0,
            recentDelegations: [],
            completionNotices: {
                deliveredBatches: 0,
                deliveredNotices: 0,
                resumePrompts: 0,
                resumePromptNotices: 0,
                pendingNotices: 0,
                deliveryFailures: { rejected: 0, unconfirmed: 0 },
            },
        },
        ...overrides,
    };
}
