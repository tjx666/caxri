import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 * Mean grayscale difference from the settled picture that marks a changed frame. The flash dims every Agent card and
 * removes the Open as group, which moves the band far past this; encoder noise stays below 1.
 */
const CHANGED_MEAN = 6;

const meanDifference = (frame: GrayFrame, reference: GrayFrame): number => {
    let total = 0;
    for (let index = 0; index < frame.data.length; index += 1)
        total += Math.abs(frame.data[index] - reference.data[index]);
    return total / frame.data.length;
};

/**
 * `MOB-NEW-SWITCH-01`: on New Session, choosing another Project must leave the Agent cards and the Open as group in
 * place. Availability is read per Project; before the previous answer was kept as a placeholder, every switch showed
 * one frame of dimmed "Checking availability…" cards with the Open as group gone, so the Project list jumped up and
 * back.
 *
 * The band from the first Agent card to the bottom of the Open as group does not depend on which Project is selected,
 * so every recorded frame of every switch is compared with the settled picture.
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
        await pause(WATCH_MS);
        await capture(environment, 'before-switch', artifacts);
        const recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        try {
            await pause(WATCH_MS);
            for (let index = 1; index <= SWITCHES; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- each switch starts from the Project the previous one chose.
                await tapMobileCheck(serial, `new-session-project-${projects[index % 2]}`);
                // eslint-disable-next-line no-await-in-loop -- the recording must cover the answer to this switch.
                await pause(WATCH_MS);
            }
        } finally {
            await recording.stop();
        }
        const video = join(analysis, 'switch.mp4');
        await copyMobileFramebufferRecording(serial, remoteVideoPath, video);
        const { frames } = await readRecordingBand(video, {
            bottom: bottomBounds.bottom,
            top: topBounds.top,
        });
        if (frames.length === 0) throw new Error('The switch recording has no frames');
        const [reference] = frames as [GrayFrame, ...GrayFrame[]];
        const differences = frames.map((frame) => meanDifference(frame, reference));
        const changedFrames = differences.filter((value) => value >= CHANGED_MEAN).length;
        const peak = Math.max(...differences);
        await capture(environment, 'after-switches', artifacts);
        if (changedFrames > 0)
            throw new Error(
                `Switching Project changed the Agent and Open as cards in ${changedFrames} frames (peak mean difference ${peak.toFixed(1)})`,
            );
        await finish(environment, artifacts, {
            frames: frames.length,
            peakMeanDifference: Number(peak.toFixed(2)),
            status: 'passed',
            switches: SWITCHES,
        });
    } finally {
        await rm(analysis, { force: true, recursive: true });
        await fixture.stop();
    }
}
