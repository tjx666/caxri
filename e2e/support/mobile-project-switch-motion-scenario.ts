import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { checkBounds, hasCheck, waitForCheck } from './mobile-agent-chat-helpers';
import type { MobileSemanticNode } from './mobile-android';
import {
    copyMobileFramebufferRecording,
    mobileSemantics,
    startMobileFramebufferRecording,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';
import { pictureChanges, readRecordingBand } from './mobile-motion-analysis';
import { dragUntil, pagingFixture } from './mobile-session-paging-scenario';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Most picture changes a list replaced without motion may show: the switch itself, the new Project's read answering,
 * and FlashList's measuring pass. A 180ms fade or slide changes the picture on nearly every frame it runs.
 */
const MAX_STILL_CHANGES = 3;
/**
 * How long each switch is watched: the tap, the new Project's read answering, and a settled tail.
 */
const WATCH_MS = 3_000;
/**
 * Half resolution keeps a fading 1px text stroke visible to the comparison.
 */
const ANALYSIS_SCALE = 2;
/**
 * Share of a row's width judged from its leading edge; a trailing status glyph may spin on its own.
 */
const ROW_JUDGED_SHARE = 0.75;
/**
 * How many row heights below the first row the analysed band spans.
 */
const JUDGED_ROWS = 4;

const isSelected = (nodes: MobileSemanticNode[], checkId: string): boolean =>
    nodes.some((node) => node.checkId === checkId && node.selected);

/**
 * `MOB-SESSION-LIST-PROJECT-SWITCH-01` (#4097): choosing a Project chip replaces the Session list at once. Before the
 * fix the rows faded and slid as if Sessions arrived, and again when the new Project's read answered.
 *
 * From All, the phone switches to the recent Project, then to the backlog one. Each switch is filmed on its own and
 * judged by how many times the top of the list changed its picture: replacing it changes it once or twice, a fade or
 * slide on nearly every frame.
 */
export async function executeMobileProjectSwitchMotionScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath)
        throw new Error('MOB-SESSION-LIST-PROJECT-SWITCH-01 judges each switch from its recording');
    const { fixture, seed } = await pagingFixture(serial);
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        const { attention, backlogProjectId, recentProjectId, recentSessionId } = seed;
        const firstRow = `session-row-${attention[0]}`;
        const all = await waitForCheck(serial, firstRow);
        const row = checkBounds(all, firstRow);
        if (!row) throw new Error(`${firstRow} is not laid out`);
        const rowHeight = row.bottom - row.top;
        const band = {
            bottom: row.top + rowHeight * JUDGED_ROWS,
            left: row.left,
            right: row.left + Math.round((row.right - row.left) * ROW_JUDGED_SHARE),
            // From the first row down, below the Project chips, whose highlight glides on every switch.
            top: row.top,
        };
        await capture(environment, 'all-projects', artifacts);

        /**
         * Films a chip tap until `isShown` holds and the watch window ends, then counts the band's picture changes.
         */
        const filmSwitch = async (
            chip: string,
            stripDirection: 'left' | 'right',
            isShown: (nodes: MobileSemanticNode[]) => boolean,
        ): Promise<ReturnType<typeof pictureChanges> & { shownAfterMs: number }> => {
            // Bring the chip on screen before filming, so the strip's scroll never lands in the recording.
            await dragUntil(serial, chip, stripDirection);
            recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
            await pause(500);
            const tappedAt = Date.now();
            await tapMobileCheckByBounds(serial, chip);
            await waitForMobile(
                () => mobileSemantics(serial),
                (nodes) => isSelected(nodes, chip) && isShown(nodes),
            );
            const shownAfterMs = Date.now() - tappedAt;
            await pause(Math.max(0, WATCH_MS - shownAfterMs));
            await recording.stop();
            recording = undefined;
            const analysis = await mkdtemp(join(tmpdir(), 'caxri-project-switch-motion-'));
            try {
                const video = join(analysis, 'segment.mp4');
                await copyMobileFramebufferRecording(serial, remoteVideoPath, video);
                const { frames } = await readRecordingBand(video, band, ANALYSIS_SCALE);
                return { ...pictureChanges(frames), shownAfterMs };
            } finally {
                await rm(analysis, { force: true, recursive: true });
            }
        };

        // Each switch replaces the top of the list: the recent Project holds one Session, the backlog dozens.
        const toRecent = await filmSwitch(
            `project-filter-${recentProjectId}`,
            'left',
            (nodes) =>
                hasCheck(nodes, `session-row-${recentSessionId}`) && !hasCheck(nodes, firstRow),
        );
        await capture(environment, 'recent-chosen', artifacts);
        const toBacklog = await filmSwitch(`project-filter-${backlogProjectId}`, 'right', (nodes) =>
            hasCheck(nodes, firstRow),
        );
        await capture(environment, 'backlog-chosen', artifacts);

        const results = { toBacklog, toRecent };
        const unchanged = Object.entries(results).filter(([, { count }]) => count === 0);
        if (unchanged.length > 0)
            throw new Error(
                `The filmed band never changed, so it cannot judge the switch: ${JSON.stringify(results)}`,
            );
        const moving = Object.entries(results).filter(([, { count }]) => count > MAX_STILL_CHANGES);
        if (moving.length > 0)
            throw new Error(`The list animated on a Project switch: ${JSON.stringify(results)}`);
        await finish(environment, artifacts, {
            status: 'passed',
            toBacklogChanges: toBacklog.count,
            toBacklogChangeSpanMs: Math.round(toBacklog.spanMs),
            toBacklogShownAfterMs: toBacklog.shownAfterMs,
            toRecentChanges: toRecent.count,
            toRecentChangeSpanMs: Math.round(toRecent.spanMs),
            toRecentShownAfterMs: toRecent.shownAfterMs,
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}
