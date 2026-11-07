import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { hasCheck } from './mobile-agent-chat-helpers';
import { mobileSemantics, waitForMobile } from './mobile-android';
import { runServerDatabase } from './run-server-database';
import type { MobileNestedSessionsSeed } from './server-database/mobile-nested-sessions-seed';

/**
 * `MOB-SESSION-LIST-NESTED-01`: a host Session that consulted a second opinion, delegated a task, and handed off to a
 * third Session. The phone's home list shows the host and the hand-off, and leaves out the consult and the delegated
 * task, which belong to the host.
 */
export async function executeMobileNestedSessionsScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    let seed: MobileNestedSessionsSeed | undefined;
    const mobile = await createMobileAcceptanceFixture({
        // No Agent launches here; the mode only decides which fixture Sessions the allowed Project keeps.
        mode: 'launch-failure',
        serial,
        // The fixture keeps its profile beside the allowed root (`<testDirectory>/user-data`) and creates it at first
        // launch, so seeding it here writes the database Caxri then opens.
        seedProject: async (allowedRoot) => {
            const testDirectory = dirname(allowedRoot);
            const userData = join(testDirectory, 'user-data');
            const root = join(testDirectory, 'nested-sessions-project');
            await Promise.all([
                mkdir(userData, { recursive: true }),
                mkdir(root, { recursive: true }),
            ]);
            seed = await runServerDatabase<MobileNestedSessionsSeed>(
                'mobile-nested-sessions-seed',
                { userData, root },
            );
        },
    });
    try {
        if (!seed) throw new Error('Nested Sessions seed is unavailable');
        const { consult, delegated, handoff, host, projectId } = seed;
        // The absent rows prove nothing unless the Server holds those Sessions with their relations.
        const { sessions } = await pageRequest<BootstrapState>(
            mobile.running.page,
            'app.bootstrap',
        );
        const relationOf = (id: string) =>
            sessions.find((session) => session.id === id && session.archivedAt === undefined)
                ?.createdByRelation;
        if (relationOf(consult) !== 'consult' || relationOf(delegated) !== 'delegated')
            throw new Error('The seeded consult and delegated Sessions are unavailable');
        await mobile.pair({ projectIds: [projectId], readyCheckId: `session-row-${host}` });
        const nodes = await waitForMobile(
            () => mobileSemantics(serial),
            (current) =>
                hasCheck(current, `session-row-${host}`) &&
                hasCheck(current, `session-row-${handoff}`),
            60_000,
        );
        // The dashboard carries all four, so a later push cannot add the hidden rows back; read once more after it.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const settled = await mobileSemantics(serial);
        const hidden = [consult, delegated].filter(
            (id) => hasCheck(nodes, `session-row-${id}`) || hasCheck(settled, `session-row-${id}`),
        );
        if (hidden.length > 0)
            throw new Error('A consult or delegated Session still has a home list row');
        await capture(environment, 'nested-sessions', artifacts);
        await finish(environment, artifacts, {
            consultRow: 'absent',
            delegatedRow: 'absent',
            handoffRow: 'shown',
            hostRow: 'shown',
            status: 'passed',
        });
    } finally {
        await mobile.stop();
    }
}
