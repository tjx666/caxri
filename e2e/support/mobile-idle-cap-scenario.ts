import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { hasCheck } from './mobile-agent-chat-helpers';
import { mobileSemantics, tapMobileCheckByBounds, waitForMobile } from './mobile-android';
import { runServerDatabase } from './run-server-database';
import type { MobileIdleCapSeed } from './server-database/mobile-idle-cap-seed';

/**
 * How long the Project page may take to show the Idle group once its Needs attention row is up.
 */
const IDLE_WAIT_MS = 20_000;

/**
 * `MOB-SESSION-LIST-IDLE-CAP-01`: a Project holds more unresolved second opinions of an archived Session than the phone
 * dashboard's cap, one Session waiting on the user, and three Idle Sessions. The home list hides the second opinions,
 * so the Project page shows the waiting Session under Needs attention and the three Sessions under Idle (issue #3946).
 * Before the fix the second opinions filled the cap and the Idle group never appeared.
 */
export async function executeMobileIdleCapScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    let seed: MobileIdleCapSeed | undefined;
    const mobile = await createMobileAcceptanceFixture({
        // No Agent launches here; the mode only decides which fixture Sessions the allowed Project keeps.
        mode: 'launch-failure',
        serial,
        // The fixture keeps its profile beside the allowed root (`<testDirectory>/user-data`) and creates it at first
        // launch, so seeding it here writes the database Caxri then opens.
        seedProject: async (allowedRoot) => {
            const testDirectory = dirname(allowedRoot);
            const userData = join(testDirectory, 'user-data');
            const root = join(testDirectory, 'idle-cap-project');
            await Promise.all([
                mkdir(userData, { recursive: true }),
                mkdir(root, { recursive: true }),
            ]);
            seed = await runServerDatabase<MobileIdleCapSeed>('mobile-idle-cap-seed', {
                userData,
                root,
            });
        },
    });
    try {
        if (!seed) throw new Error('Idle cap seed is unavailable');
        const { idle, projectId, waiting } = seed;
        await mobile.pair({ projectIds: [projectId], readyCheckId: `session-row-${waiting}` });
        await tapMobileCheckByBounds(serial, `project-filter-${projectId}`);
        const isIdleShown = (nodes: Awaited<ReturnType<typeof mobileSemantics>>) =>
            hasCheck(nodes, 'session-group-idle') &&
            idle.every((id) => hasCheck(nodes, `session-row-${id}`));
        let nodes: Awaited<ReturnType<typeof mobileSemantics>>;
        try {
            nodes = await waitForMobile(
                () => mobileSemantics(serial),
                (current) => hasCheck(current, `session-row-${waiting}`) && isIdleShown(current),
                IDLE_WAIT_MS,
            );
        } catch {
            // The baseline build never shows the Idle group; read what it does show and fail with that capture.
            nodes = await mobileSemantics(serial);
        }
        await capture(environment, 'project-page', artifacts);
        const shownIdle = idle.filter((id) => hasCheck(nodes, `session-row-${id}`)).length;
        const receipt = {
            hiddenConsultCount: seed.hiddenConsultCount,
            idleGroup: hasCheck(nodes, 'session-group-idle') ? 'shown' : 'absent',
            idleRowsShown: `${shownIdle}/${idle.length}`,
            waitingRow: hasCheck(nodes, `session-row-${waiting}`) ? 'shown' : 'absent',
        };
        if (!isIdleShown(nodes) || !hasCheck(nodes, `session-row-${waiting}`)) {
            // Keep the capture citable in the failed (baseline) round before failing it.
            await finish(environment, artifacts, { ...receipt, status: 'failed' });
            throw new Error('The Project page does not show its Idle Sessions');
        }
        await finish(environment, artifacts, { ...receipt, status: 'passed' });
    } finally {
        await mobile.stop();
    }
}
