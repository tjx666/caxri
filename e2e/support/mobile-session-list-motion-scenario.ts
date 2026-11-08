import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    androidBounds,
    copyMobileFramebufferRecording,
    mobileSemantics,
    setMobileNetworkAvailable,
    startMobileFramebufferRecording,
    tapMobileCheck,
} from './mobile-android';
import { inBetweenFrames, readRecordingBand } from './mobile-motion-analysis';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fewest in-between frames that read as motion. A change applied in one commit draws at most one (FlashList's measuring
 * pass); the 120ms to 180ms fades draw about one per frame.
 */
const MIN_IN_BETWEEN_FRAMES = 3;
/**
 * How long each filmed change is watched: the push from Desktop, the animation, and a settled tail.
 */
const WATCH_MS = 3_000;
/**
 * An outage long enough that the Reconnecting capsule must appear.
 */
const OUTAGE_MS = 9_000;
/**
 * Downscale factor for the analysed bands: half resolution keeps a fading 1px text stroke visible to the comparison.
 */
const ANALYSIS_SCALE = 2;
/**
 * Share of a row's width judged from its leading edge. The trailing status glyph may spin, which would read as motion
 * on its own.
 */
const ROW_JUDGED_SHARE = 0.75;

type Recording = Awaited<ReturnType<typeof startMobileFramebufferRecording>>;
interface Band {
    bottom: number;
    left: number;
    right: number;
    top: number;
}

/**
 * The capsule's label area: inside its border and right of its spinner, which turns the whole time the capsule shows.
 * The spinner and its padding take about 1.3 capsule heights.
 */
const capsuleLabel = ({ bottom, left, right, top }: Band): Band => ({
    bottom: bottom - 4,
    left: left + Math.round((bottom - top) * 1.3),
    right: right - 12,
    top: top + 4,
});

/**
 * `MOB-SESSION-LIST-MOTION-01` (#3815): Session rows and the Reconnecting capsule animate instead of popping.
 *
 * 1. A Session created on Desktop fades into the phone's list while the existing row slides down to make room.
 * 2. Archiving it on Desktop fades it out while the remaining row slides back up.
 * 3. Opening a Session while offline drops the saved copy's age from the capsule's label; the new label fades in while the
 *    capsule narrows, instead of swapping in one frame.
 * 4. When the network returns, the capsule fades out instead of vanishing in one frame. The runner keeps this last
 *    recording as the evidence video.
 *
 * Each change is filmed on its own and judged by the frames drawn between its first and last picture, inside a band
 * that holds still apart from that change.
 */
export async function executeMobileSessionListMotionScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath)
        throw new Error('MOB-SESSION-LIST-MOTION-01 judges each change from its recording');
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let recording: Recording | undefined;
    const network = { isOffline: false };
    const setOnline = async (isOnline: boolean): Promise<void> => {
        await setMobileNetworkAvailable(serial, isOnline);
        network.isOffline = !isOnline;
    };
    const boundsOf = async (checkId: string): Promise<Band> => {
        const node = (await mobileSemantics(serial)).find((entry) => entry.checkId === checkId);
        const bounds = node && androidBounds(node.bounds);
        if (!bounds) throw new Error(`${checkId} is not laid out`);
        return bounds;
    };
    /**
     * Films `act`, then counts the frames drawn between the first and last picture of the band `bandOf` returns once
     * `act` has finished.
     */
    const filmChange = async (bandOf: () => Promise<Band>, act: () => Promise<void>) => {
        recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        await pause(500);
        await act();
        await pause(WATCH_MS);
        await recording.stop();
        recording = undefined;
        const band = await bandOf();
        const analysis = await mkdtemp(join(tmpdir(), 'caxri-session-list-motion-'));
        try {
            const video = join(analysis, 'segment.mp4');
            await copyMobileFramebufferRecording(serial, remoteVideoPath, video);
            return inBetweenFrames((await readRecordingBand(video, band, ANALYSIS_SCALE)).frames);
        } finally {
            await rm(analysis, { force: true, recursive: true });
        }
    };
    try {
        const sessionId = fixture.allowedSessionId;
        if (!sessionId) throw new Error('Chat fixture is unavailable');
        const { page } = fixture.running;
        const row = `session-row-${sessionId}`;
        await fixture.pair();
        await waitForCheck(serial, row);
        await waitForNoCheck(serial, 'connection-stale-banner', 60_000);
        const first = await boundsOf(row);
        // The slot the existing row holds now and the one below it, where it moves once a newer Session lists above.
        const rows: Band = {
            bottom: first.bottom + (first.bottom - first.top),
            left: first.left,
            right: first.left + Math.round((first.right - first.left) * ROW_JUDGED_SHARE),
            top: first.top,
        };
        const rowBand = () => Promise.resolve(rows);

        // 1. A Session created on Desktop enters the list.
        let createdId = '';
        const enter = await filmChange(rowBand, async () => {
            createdId = (
                await pageRequest<{ session: { id: string } }>(page, 'session.create', {
                    defaultAgent: 'codex',
                    projectId: fixture.allowedProjectId,
                    surface: 'chat',
                })
            ).session.id;
        });
        await waitForCheck(serial, `session-row-${createdId}`);
        await capture(environment, 'session-entered', artifacts);

        // 2. Archiving it on Desktop takes it out of the list.
        const leave = await filmChange(rowBand, async () => {
            await pageRequest(page, 'session.archive', { sessionId: createdId });
        });
        await waitForNoCheck(serial, `session-row-${createdId}`);
        await capture(environment, 'session-left', artifacts);

        // 3. Offline over the list, the capsule carries the saved copy's age; opening a Session drops it.
        await setOnline(false);
        await pause(OUTAGE_MS);
        await waitForCheck(serial, 'session-list-saved', 30_000);
        await capture(environment, 'capsule-over-list', artifacts);
        const labelChange = await filmChange(
            async () => capsuleLabel(await boundsOf('connection-stale-banner')),
            async () => {
                await tapMobileCheck(serial, row);
            },
        );
        await capture(environment, 'capsule-in-session', artifacts);

        // 4. The capsule leaves when the network returns.
        const capsule = capsuleLabel(await boundsOf('connection-stale-banner'));
        const capsuleExit = await filmChange(
            () => Promise.resolve(capsule),
            async () => {
                await setOnline(true);
                await waitForNoCheck(serial, 'connection-stale-banner', 60_000);
            },
        );
        await capture(environment, 'capsule-gone', artifacts);

        const results = { capsuleExit, enter, labelChange, leave };
        const still = Object.entries(results).filter(
            ([, { count }]) => count < MIN_IN_BETWEEN_FRAMES,
        );
        if (still.length > 0)
            throw new Error(
                `Changed in one step without motion: ${JSON.stringify(Object.fromEntries(still))}`,
            );
        await finish(environment, artifacts, {
            capsuleExitInBetweenFrames: capsuleExit.count,
            capsuleExitMs: Math.round(capsuleExit.spanMs),
            enterInBetweenFrames: enter.count,
            enterMs: Math.round(enter.spanMs),
            labelChangeInBetweenFrames: labelChange.count,
            labelChangeMs: Math.round(labelChange.spanMs),
            leaveInBetweenFrames: leave.count,
            leaveMs: Math.round(leave.spanMs),
            status: 'passed',
        });
    } finally {
        if (network.isOffline) await setMobileNetworkAvailable(serial, true);
        await recording?.stop();
        await fixture.stop();
    }
}
