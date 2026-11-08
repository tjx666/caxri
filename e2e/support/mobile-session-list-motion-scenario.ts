import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { agentText, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    androidBounds,
    copyMobileFramebufferRecording,
    mobileSemantics,
    setMobileNetworkAvailable,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
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
 * The middle of the saved-messages note's pill. The note's host spans the screen above the timeline; its pill is
 * centered below a small top padding, and its sentence is wider than the middle 40% of the screen.
 */
const savedNotePill = ({ bottom, left, right, top }: Band): Band => ({
    bottom: bottom - 4,
    left: left + Math.round((right - left) * 0.3),
    right: right - Math.round((right - left) * 0.3),
    top: top + Math.round((bottom - top) * 0.4),
});

/**
 * The read cache writes one second after the live view settles; this leaves room for that write.
 */
const READ_CACHE_SETTLE_MS = 2_500;

/**
 * `MOB-SESSION-LIST-MOTION-01` (#3815): Session rows and the Reconnecting capsule animate instead of popping.
 *
 * 1. A Session created on Desktop fades into the phone's list while the existing row slides down to make room.
 * 2. Archiving it on Desktop fades it out while the remaining row slides back up.
 * 3. Opening a Session while offline drops the saved copy's age from the capsule's label; the new label fades in while the
 *    capsule narrows, instead of swapping in one frame.
 * 4. When the network returns, the live read replaces the saved Chat: its "Showing messages saved ..." note and the
 *    capsule both fade out instead of vanishing in one frame. The runner keeps this last recording as the evidence
 *    video.
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
     * Films `act`, then counts the frames drawn between the first and last picture of each band `bandsOf` returns once
     * `act` has finished.
     */
    const filmChanges = async (
        bandsOf: () => Promise<Band[]>,
        act: () => Promise<void>,
    ): Promise<Array<ReturnType<typeof inBetweenFrames>>> => {
        recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        await pause(500);
        await act();
        await pause(WATCH_MS);
        await recording.stop();
        recording = undefined;
        const bands = await bandsOf();
        const analysis = await mkdtemp(join(tmpdir(), 'caxri-session-list-motion-'));
        try {
            const video = join(analysis, 'segment.mp4');
            await copyMobileFramebufferRecording(serial, remoteVideoPath, video);
            return await Promise.all(
                bands.map(async (band) =>
                    inBetweenFrames((await readRecordingBand(video, band, ANALYSIS_SCALE)).frames),
                ),
            );
        } finally {
            await rm(analysis, { force: true, recursive: true });
        }
    };
    const filmChange = async (bandOf: () => Promise<Band>, act: () => Promise<void>) => {
        const [result] = await filmChanges(async () => [await bandOf()], act);
        return result;
    };
    try {
        const sessionId = fixture.allowedSessionId;
        const chat = fixture.agentChat;
        if (!sessionId || !chat) throw new Error('Chat fixture is unavailable');
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

        // The phone reads the Chat once online, so it keeps a saved copy to open offline.
        await chat.send({ text: 'hello' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('You said: hello') && !snapshot.activeTurnId,
        );
        // The finished reply moves the row to Needs attention; tap it only once it holds its new place.
        await waitForMobile(
            async () => JSON.stringify(await boundsOf(row)),
            (() => {
                let previous = '';
                return (bounds: string) => {
                    const isSettled = bounds === previous;
                    previous = bounds;
                    return isSettled;
                };
            })(),
        );
        await pause(1_000);
        await tapMobileCheck(serial, row);
        try {
            await waitForCheck(serial, 'agent-chat');
        } catch (error) {
            await capture(environment, 'chat-not-opened', artifacts);
            throw error;
        }
        await waitForNoCheck(serial, 'agent-chat-saved');
        await pause(READ_CACHE_SETTLE_MS);
        await tapMobileCheck(serial, 'session-detail-back');
        await waitForCheck(serial, row);

        // 3. Offline over the list, the capsule carries the saved copy's age; opening the Session drops it.
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
        await waitForCheck(serial, 'agent-chat-saved');
        await capture(environment, 'saved-chat-offline', artifacts);

        // 4. The network returns: the live read replaces the saved Chat, and its note and the capsule both leave.
        const capsule = capsuleLabel(await boundsOf('connection-stale-banner'));
        const note = savedNotePill(await boundsOf('agent-chat-saved'));
        const [capsuleExit, noteExit] = await filmChanges(
            () => Promise.resolve([capsule, note]),
            async () => {
                await setOnline(true);
                await waitForNoCheck(serial, 'connection-stale-banner', 60_000);
                await waitForNoCheck(serial, 'agent-chat-saved', 60_000);
            },
        );
        await capture(environment, 'live-chat', artifacts);

        const results = { capsuleExit, enter, labelChange, leave, noteExit };
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
            noteExitInBetweenFrames: noteExit.count,
            noteExitMs: Math.round(noteExit.spanMs),
            status: 'passed',
        });
    } finally {
        if (network.isOffline) await setMobileNetworkAvailable(serial, true);
        await recording?.stop();
        await fixture.stop();
    }
}
