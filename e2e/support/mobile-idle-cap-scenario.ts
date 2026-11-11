import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { checkBounds, hasCheck } from './mobile-agent-chat-helpers';
import { mobileSemantics, tapMobileCheckByBounds, waitForMobile } from './mobile-android';
import { runServerDatabase } from './run-server-database';
import type { MobileIdleCapSeed } from './server-database/mobile-idle-cap-seed';

/**
 * How long the Project page may take to show the Idle group once its Needs attention row is up.
 */
const IDLE_WAIT_MS = 20_000;

/**
 * A Session row's own check id, `session-row-<uuid>`; the row's swipe, mark-done, and archive controls share the
 * prefix.
 */
const SESSION_ROW_CHECK = /^session-row-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u;

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
        const { archivedHost, hiddenConsults, idle, projectId, waiting } = seed;
        // The absent rows prove nothing unless the Server holds every second opinion unresolved under an archived creator.
        const { sessions } = await pageRequest<BootstrapState>(
            mobile.running.page,
            'app.bootstrap',
        );
        const loadedHidden = sessions.filter(
            (session) =>
                hiddenConsults.includes(session.id) &&
                session.archivedAt === undefined &&
                session.createdByRelation === 'consult' &&
                session.createdBySessionId === archivedHost &&
                session.hasPendingAttention,
        ).length;
        const isCreatorArchived =
            sessions.find((session) => session.id === archivedHost)?.archivedAt !== undefined;
        if (!isCreatorArchived || loadedHidden !== hiddenConsults.length)
            throw new Error(
                'The seeded second opinions are not unresolved under an archived creator',
            );
        await mobile.pair({ projectIds: [projectId], readyCheckId: `session-row-${waiting}` });
        await tapMobileCheckByBounds(serial, `project-filter-${projectId}`);
        type Nodes = Awaited<ReturnType<typeof mobileSemantics>>;
        const top = (nodes: Nodes, id: string) => checkBounds(nodes, id)?.top;
        /**
         * The waiting row sits between the Needs attention heading and the Idle heading, and every Idle row below it.
         */
        const isGrouped = (nodes: Nodes): boolean => {
            const attention = top(nodes, 'session-group-attention');
            const idleHeader = top(nodes, 'session-group-idle');
            const waitingTop = top(nodes, `session-row-${waiting}`);
            if (attention === undefined || idleHeader === undefined || waitingTop === undefined)
                return false;
            return (
                attention < waitingTop &&
                waitingTop < idleHeader &&
                idle.every((id) => (top(nodes, `session-row-${id}`) ?? -1) > idleHeader)
            );
        };
        const isProjectSelected = (nodes: Nodes) =>
            nodes.some(
                ({ checkId, selected }) => checkId === `project-filter-${projectId}` && selected,
            );
        const expectedRows = new Set([waiting, ...idle].map((id) => `session-row-${id}`));
        /**
         * Every Session row the list mounted, which must be exactly the waiting row and the three Idle rows: a leaked
         * second opinion, or another Project's row on an unfiltered page, adds a row the virtualized list mounts next
         * to them.
         */
        const unexpectedRows = (nodes: Nodes) =>
            nodes.filter(
                ({ checkId }) => SESSION_ROW_CHECK.test(checkId) && !expectedRows.has(checkId),
            ).length;
        const leakedConsults = (nodes: Nodes) =>
            hiddenConsults.filter((id) => hasCheck(nodes, `session-row-${id}`)).length;
        let nodes: Nodes;
        try {
            nodes = await waitForMobile(
                () => mobileSemantics(serial),
                (current) => isProjectSelected(current) && isGrouped(current),
                IDLE_WAIT_MS,
            );
        } catch {
            // The baseline build never shows the Idle group; read what it does show and fail with that capture.
            nodes = await mobileSemantics(serial);
        }
        // Read again after any late push could add rows back.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const settled = await mobileSemantics(serial);
        await capture(environment, 'project-page', artifacts);
        const shownIdle = idle.filter((id) => hasCheck(settled, `session-row-${id}`)).length;
        const receipt = {
            archivedCreator: 'archived',
            projectFilterSelected: isProjectSelected(settled),
            unexpectedRowsShown: Math.max(unexpectedRows(nodes), unexpectedRows(settled)),
            hiddenConsultsLoaded: loadedHidden,
            hiddenConsultRowsShown: Math.max(leakedConsults(nodes), leakedConsults(settled)),
            idleGroup: hasCheck(settled, 'session-group-idle') ? 'shown' : 'absent',
            idleRowsShown: `${shownIdle}/${idle.length}`,
            waitingUnderAttention: isGrouped(settled),
        };
        if (
            !receipt.projectFilterSelected ||
            !isGrouped(settled) ||
            receipt.hiddenConsultRowsShown > 0 ||
            receipt.unexpectedRowsShown > 0
        ) {
            // Keep the capture citable in a failed round before failing it.
            await finish(environment, artifacts, { ...receipt, status: 'failed' });
            throw new Error(
                'The Project page does not show its Idle Sessions with the second opinions hidden',
            );
        }
        await finish(environment, artifacts, { ...receipt, status: 'passed' });
    } finally {
        await mobile.stop();
    }
}
