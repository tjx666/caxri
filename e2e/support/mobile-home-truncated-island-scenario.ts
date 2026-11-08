import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import type { MobileSemanticNode } from './mobile-android';
import {
    adbShell,
    androidBounds,
    coldStartMobileApp,
    copyMobileFramebufferRecording,
    mobileSemantics,
    startMobileFramebufferRecording,
} from './mobile-android';
import { heldPicturesBeforeFinalAt, readRecordingBand } from './mobile-motion-analysis';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The Session cap of the phone's dashboard read (`mobileDashboardResultSchema`): one more Session truncates the list.
 */
const DASHBOARD_SESSION_CAP = 64;
/**
 * Shortest hold that a reader sees as a separate picture.
 */
const HOLD_MS = 80;
/**
 * How long the recording runs after the island is gone.
 */
const WATCH_AFTER_MS = 3_000;
const CREATE_BATCH = 8;

const firstRowTop = (nodes: readonly MobileSemanticNode[]): number | undefined => {
    const tops = nodes
        .filter(({ checkId }) => checkId.startsWith('session-row-'))
        .map(({ bounds }) => androidBounds(bounds)?.top)
        .filter((top): top is number => top !== undefined);
    return tops.length > 0 ? Math.min(...tops) : undefined;
};

/**
 * `MOB-SESSION-NOTICE-ISLAND-01`: a paired phone whose Session list holds exactly the dashboard cap, then one more
 * Session (#3805).
 *
 * 1. The truncated notice floats as a capsule over the header without moving the Project filter row or the first Session
 *    row, and is gone after its visible window without the list moving.
 * 2. After a cold start the capsule shows again (once per count per app process) and tapping it opens Session search.
 */
export async function executeMobileHomeTruncatedIslandScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath)
        throw new Error('MOB-SESSION-NOTICE-ISLAND-01 judges the list from its recording');
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        const { page } = fixture.running;
        if (!fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await fixture.pair();
        await waitForCheck(serial, `session-row-${fixture.allowedSessionId}`);
        /**
         * Terminal-less Sessions: Caxri allows 32 Terminals at most, far below the 64 rows a full list needs.
         */
        const createSession = () =>
            pageRequest(page, 'session.create', {
                projectId: fixture.allowedProjectId,
                defaultAgent: null,
            });
        // One Session exists, so cap - 1 more make the full, untruncated list.
        for (let created = 1; created < DASHBOARD_SESSION_CAP; created += CREATE_BATCH) {
            const count = Math.min(CREATE_BATCH, DASHBOARD_SESSION_CAP - created);
            // eslint-disable-next-line no-await-in-loop -- batches keep the Desktop Server from starting every Chat at once.
            await Promise.all(Array.from({ length: count }, createSession));
        }
        await pause(4_000);
        const full = await mobileSemantics(serial);
        if (full.some(({ checkId }) => checkId === 'session-list-truncated'))
            throw new Error('The list at the cap already shows the truncated notice');
        const filters = full.find(({ checkId }) => checkId === 'session-project-filters');
        const band = filters && androidBounds(filters.bounds);
        const baselineRow = firstRowTop(full);
        if (!band || baselineRow === undefined) throw new Error('The Session list is not laid out');
        await capture(environment, 'full-list-no-notice', artifacts);

        // The one Session past the cap, filmed from before it is created until after the capsule's window.
        recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        await pause(500);
        await createSession();
        const shown = await waitForCheck(serial, 'session-list-truncated', 30_000);
        const shownAt = Date.now();
        // Captured at once, from the read that found the capsule: it is up for only about 4 seconds. Before any
        // assertion, so a baseline run on the previous banner still keeps its screenshot.
        await capture(environment, 'capsule-visible', artifacts);
        const capsule = shown.find(({ checkId }) => checkId === 'session-list-truncated');
        const capsuleBounds = capsule && androidBounds(capsule.bounds);
        if (!capsuleBounds) throw new Error('The truncated capsule is not laid out');
        const shownFilters = shown.find(({ checkId }) => checkId === 'session-project-filters');
        const shownBand = shownFilters && androidBounds(shownFilters.bounds);
        if (!shownBand || shownBand.top !== band.top || shownBand.bottom !== band.bottom)
            throw new Error(
                `The truncated notice moved the Project filter row from ${band.top} to ${shownBand?.top}`,
            );
        const shownRow = firstRowTop(shown);
        if (shownRow !== baselineRow)
            throw new Error(
                `The truncated notice moved the first Session row from ${baselineRow} to ${shownRow}`,
            );
        await waitForNoCheck(serial, 'session-list-truncated', 15_000);
        // Polling lags the real 4 second window both ways, so the bounds are loose: it must neither stay nor vanish at once.
        const visibleMs = Date.now() - shownAt;
        if (visibleMs < 2_000 || visibleMs > 8_000)
            throw new Error(`The capsule stayed for ${visibleMs}ms instead of about 4 seconds`);
        await pause(WATCH_AFTER_MS);
        await recording.stop();
        recording = undefined;
        const gone = await mobileSemantics(serial);
        if (firstRowTop(gone) !== baselineRow)
            throw new Error(
                `The first Session row moved to ${firstRowTop(gone)} after the capsule left`,
            );
        await capture(environment, 'capsule-gone', artifacts);

        const analysis = await mkdtemp(join(tmpdir(), 'caxri-truncated-island-'));
        let held: Array<{ heldMs: number; time: number }>;
        try {
            const video = join(analysis, 'segment.mp4');
            await copyMobileFramebufferRecording(serial, remoteVideoPath, video);
            held = heldPicturesBeforeFinalAt(
                (await readRecordingBand(video, band)).frames,
                HOLD_MS,
            );
        } finally {
            await rm(analysis, { force: true, recursive: true });
        }
        if (held.length > 0)
            throw new Error(
                `The Project filter row moved while the capsule came and went: ${JSON.stringify(held)}`,
            );

        // A cold start is a new app process, so the capsule is first drawn again; tapping it opens Session search.
        await coldStartMobileApp(serial);
        const restarted = await waitForCheck(serial, 'session-list-truncated-search', 60_000);
        // Tapped at once at the bounds just read: the capsule is only up for about 4 seconds, which a screenshot or a
        // second semantics read would eat. The semantic tap helper refuses a Pressable that reports clickable=false.
        const searchNode = restarted.find(
            ({ checkId }) => checkId === 'session-list-truncated-search',
        );
        const search = searchNode && androidBounds(searchNode.bounds);
        if (!search) throw new Error('The capsule search action is not laid out');
        await adbShell(serial, [
            'input',
            'tap',
            String(Math.floor((search.left + search.right) / 2)),
            String(Math.floor((search.top + search.bottom) / 2)),
        ]);
        await waitForCheck(serial, 'session-search-screen');
        await capture(environment, 'search-opened', artifacts);

        await finish(environment, artifacts, {
            capsuleBottomPx: capsuleBounds.bottom,
            capsuleVisibleMs: visibleMs,
            filterRowHeldPictures: held.length,
            filterRowTopPx: band.top,
            firstRowTopPx: baselineRow,
            layoutStable: true,
            searchOpened: true,
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}
