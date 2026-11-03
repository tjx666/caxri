import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import {
    adbShell,
    androidBounds,
    copyMobileFramebufferRecording,
    mobileRegionFingerprint,
    mobileSemantics,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';
import { departuresFromFinalPicture, readRecordingBand } from './mobile-motion-analysis';
import type { Environment } from './mobile-project-panels-scenarios';
import { addProjectFromPhone, capture, finish, hasCheck } from './mobile-project-panels-scenarios';

const chipBounds = (nodes: Awaited<ReturnType<typeof mobileSemantics>>, projectId: string) => {
    const node = nodes.find(({ checkId }) => checkId === `project-filter-${projectId}`);
    return (node && androidBounds(node.bounds)) ?? undefined;
};

/**
 * `MOB-PROJECT-REORDER-01`: the phone holds two of the Mac's three Projects. Dragging the second Project chip in front
 * of the first moves it on the phone and in the Mac's Project order, while the Project the phone cannot see keeps its
 * place relative to the others; a plain tap on a chip still filters.
 *
 * The drop is recorded: once the strip first shows its final order it must hold it, since the move's own dashboard
 * event once settled the refresh early and the strip flashed the old order for a frame (#3532).
 */
export async function executeMobileProjectReorderScenario(
    environment: Environment,
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath } = environment;
    if (!remoteVideoPath)
        throw new Error('MOB-PROJECT-REORDER-01 judges the drop from its recording');
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    const fixture = await createMobileAcceptanceFixture({
        isolatedProjectHome: true,
        mode: 'launch-failure',
        serial: environment.serial,
    });
    const desktopOrder = async () =>
        (await pageRequest<BootstrapState>(fixture.running.page, 'app.bootstrap')).projects
            .filter(({ ownerProjectId }) => ownerProjectId === undefined)
            .map(({ id }) => id);
    try {
        await fixture.pair();
        if (!fixture.allowedSessionId) throw new Error('The allowed Project has no Session');
        const addedId = await addProjectFromPhone(environment, fixture);
        await adbShell(environment.serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        const allowedId = fixture.allowedProjectId;
        const hiddenId = fixture.deniedProjectId;
        const before = await desktopOrder();
        if (before.join(',') !== [allowedId, hiddenId, addedId].join(','))
            throw new Error(`Unexpected starting Project order: ${before.join(',')}`);
        const nodes = await waitForMobile(
            () => mobileSemantics(environment.serial),
            (current) =>
                chipBounds(current, allowedId) !== undefined &&
                chipBounds(current, addedId) !== undefined,
        );
        const allowed = chipBounds(nodes, allowedId)!;
        const added = chipBounds(nodes, addedId)!;
        if (!(allowed.left < added.left)) throw new Error('Chips did not start in Mac order');
        await capture(environment, 'before', artifacts);

        // UIAutomator waits for an idle screen, so the moving strip is compared by its pixels instead.
        const strip = {
            bottom: added.bottom + 8,
            left: allowed.left - 8,
            right: added.right + 8,
            top: added.top - 8,
        };
        const resting = await mobileRegionFingerprint(environment.serial, strip);
        // The finger stays down past the pick-up delay, slides onto the other chip, and holds there while the frame is
        // captured, so the evidence shows the lifted chip and its neighbor stepping aside before the drop.
        const y = Math.floor((added.top + added.bottom) / 2);
        const fromX = Math.floor((added.left + added.right) / 2);
        const toX = allowed.left + 4;
        const steps = 12;
        await adbShell(environment.serial, [
            [
                `input motionevent DOWN ${fromX} ${y}`,
                'sleep 0.8',
                ...Array.from(
                    { length: steps },
                    (_, index) =>
                        `input motionevent MOVE ${Math.round(fromX + ((toX - fromX) * (index + 1)) / steps)} ${y}`,
                ),
                'sleep 0.5',
            ].join('; '),
        ]);
        const moving = await mobileRegionFingerprint(environment.serial, strip);
        await capture(environment, 'dragging', artifacts);
        recording = await startMobileFramebufferRecording(environment.serial, remoteVideoPath);
        await adbShell(environment.serial, ['input', 'motionevent', 'UP', String(toX), String(y)]);
        if (moving === resting) throw new Error('The held chip did not move while dragged');
        const after = await waitForMobile(desktopOrder, (order) => order[0] === addedId);
        if (after.join(',') !== [addedId, allowedId, hiddenId].join(','))
            throw new Error(`Unexpected Project order after the drag: ${after.join(',')}`);
        const moved = await waitForMobile(
            () => mobileSemantics(environment.serial),
            (current) => {
                const first = chipBounds(current, addedId);
                const second = chipBounds(current, allowedId);
                return first !== undefined && second !== undefined && first.left < second.left;
            },
        );
        if (moved.some(({ checkId }) => checkId === `project-filter-${hiddenId}`))
            throw new Error('The phone showed a Project outside its grant');
        if (moving === (await mobileRegionFingerprint(environment.serial, strip)))
            throw new Error('The dragging frame matched the dropped strip instead of a held chip');
        await capture(environment, 'after', artifacts);
        await recording.stop();
        recording = undefined;
        const analysis = await mkdtemp(join(tmpdir(), 'caxri-project-reorder-'));
        let dropDepartures: number;
        try {
            const video = join(analysis, 'drop.mp4');
            await copyMobileFramebufferRecording(environment.serial, remoteVideoPath, video);
            const { frames } = await readRecordingBand(video, strip);
            const { departures, settledAt } = departuresFromFinalPicture(frames);
            if (departures > 0)
                throw new Error(
                    `The strip left its dropped order for ${departures} frames after ${Math.round(settledAt)}ms`,
                );
            dropDepartures = departures;
        } finally {
            await rm(analysis, { force: true, recursive: true });
        }

        // A plain tap still filters: the moved Project has no Sessions, so the other Project's Session leaves the list.
        await tapMobileCheck(environment.serial, `project-filter-${addedId}`);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (current) =>
                current.some(
                    ({ checkId, selected }) => checkId === `project-filter-${addedId}` && selected,
                ) && !hasCheck(current, `session-row-${fixture.allowedSessionId}`),
        );
        await capture(environment, 'tap-filters', artifacts);
        await finish(environment, artifacts, {
            desktopOrderAfter: 'moved-first-hidden-kept-after',
            dropDepartures,
            phoneOrderAfter: 'moved-first',
            tapStillFilters: true,
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}
