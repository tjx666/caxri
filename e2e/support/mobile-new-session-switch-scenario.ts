import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    androidBounds,
    copyMobileFramebufferRecording,
    mobileSemantics,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';
import type { GrayFrame } from './mobile-motion-analysis';
import { readRecordingBand } from './mobile-motion-analysis';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Each switch answers in a frame or two on the emulator, so the case switches back and forth several times.
 */
const SWITCHES = 6;
const WATCH_MS = 1_200;

/**
 * Grayscale step a pixel must move from the settled picture to count as changed; encoder noise stays well below it.
 */
const PIXEL_CHANGE = 16;
/**
 * Share of changed pixels that marks a frame as changed. Dimming the Agent cards alone repaints every label and icon,
 * and dropping the Open as group repaints most of the band, so either passes this by a wide margin.
 */
const CHANGED_SHARE = 0.02;

const changedShare = (frame: GrayFrame, reference: GrayFrame): number => {
    let changed = 0;
    for (let index = 0; index < frame.data.length; index += 1)
        if (Math.abs(frame.data[index] - reference.data[index]) >= PIXEL_CHANGE) changed += 1;
    return changed / frame.data.length;
};

/**
 * Waits until the phone shows `projectId` as the chosen Project, so a tap that missed cannot pass as a steady switch.
 */
const waitForSelectedProject = (serial: string, projectId: string) =>
    waitForMobile(
        () => mobileSemantics(serial),
        (nodes) =>
            nodes.some(
                ({ checkId, selected }) =>
                    checkId === `new-session-project-${projectId}` && selected,
            ),
    );

/**
 * `MOB-NEW-SWITCH-01`: on New Session, choosing another Project must leave the Agent cards and the Open as group in
 * place. Availability is read per Project; before the previous answer was kept as a placeholder, every switch showed
 * one frame of dimmed "Checking availability…" cards with the Open as group gone, so the Project list jumped up and
 * back.
 *
 * The band from the first Agent card to the bottom of the Open as group does not depend on which Project is selected,
 * so every recorded frame of every switch is compared with the settled picture the recording ends on.
 */
export async function executeMobileNewSessionSwitchScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath)
        throw new Error('MOB-NEW-SWITCH-01 judges each switch from its recording');
    const fixture = await createMobileAcceptanceFixture({ mode: 'conversation', serial });
    const analysis = await mkdtemp(join(tmpdir(), 'caxri-new-session-switch-'));
    try {
        const projects = [fixture.allowedProjectId, fixture.deniedProjectId];
        // The second Project carries the fixture's out-of-grant Session; it goes first so granting that Project shows the
        // phone two Projects without tripping the fixture's grant check.
        if (fixture.deniedSessionId)
            await pageRequest(fixture.running.page, 'session.delete', {
                sessionId: fixture.deniedSessionId,
            });
        await fixture.pair([fixture.deniedProjectId]);
        await tapMobileCheck(serial, 'new-session-button');
        const settled = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                projects.every((id) =>
                    nodes.some(({ checkId }) => checkId === `new-session-project-${id}`),
                ) &&
                nodes.some(
                    ({ checkId, enabled }) => checkId === 'new-session-agent-claude' && enabled,
                ) &&
                nodes.some(({ checkId }) => checkId === 'new-session-surface-chat'),
        );
        const top = settled.find(({ checkId }) => checkId === 'new-session-agent-claude');
        const bottom = settled.find(({ checkId }) => checkId === 'new-session-surface-chat');
        const topBounds = top && androidBounds(top.bounds);
        const bottomBounds = bottom && androidBounds(bottom.bounds);
        if (!topBounds || !bottomBounds) throw new Error('New Session cards are not laid out');
        await tapMobileCheck(serial, `new-session-project-${projects[0]}`);
        await waitForSelectedProject(serial, projects[0]);
        await pause(WATCH_MS);
        await capture(environment, 'before-switch', artifacts);
        const recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        try {
            await pause(WATCH_MS);
            for (let index = 1; index <= SWITCHES; index += 1) {
                const projectId = projects[index % 2];
                // eslint-disable-next-line no-await-in-loop -- each switch starts from the Project the previous one chose.
                await tapMobileCheck(serial, `new-session-project-${projectId}`);
                // eslint-disable-next-line no-await-in-loop -- the next switch must start from this one's answer.
                await waitForSelectedProject(serial, projectId);
                // eslint-disable-next-line no-await-in-loop -- the recording must cover the settled answer.
                await pause(WATCH_MS);
            }
        } finally {
            await recording.stop();
        }
        const video = join(analysis, 'switch.mp4');
        await copyMobileFramebufferRecording(serial, remoteVideoPath, video);
        const { frames } = await readRecordingBand(
            video,
            { bottom: bottomBounds.bottom, top: topBounds.top },
            2,
        );
        const reference = frames.at(-1);
        if (!reference) throw new Error('The switch recording has no frames');
        const shares = frames.map((frame) => changedShare(frame, reference));
        const changed = frames.filter((_, index) => shares[index] >= CHANGED_SHARE);
        const peakShare = Math.max(...shares);
        const peakTimeMs = frames[shares.indexOf(peakShare)].time;
        await capture(environment, 'after-switches', artifacts);
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(({ checkId, enabled }) => checkId === 'new-session-create' && enabled),
        );
        if (changed.length > 0)
            throw new Error(
                `Switching Project changed the Agent and Open as cards in ${changed.length} frames at ${changed.map(({ time }) => Math.round(time)).join(', ')} ms (peak changed share ${peakShare.toFixed(3)})`,
            );
        await finish(environment, artifacts, {
            frames: frames.length,
            peakChangedShare: Number(peakShare.toFixed(4)),
            peakTimeMs: Math.round(peakTimeMs),
            status: 'passed',
            switches: SWITCHES,
        });
    } finally {
        await rm(analysis, { force: true, recursive: true });
        await fixture.stop();
    }
}
