import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture.ts';
import { hasCheck } from './mobile-agent-chat-helpers.ts';
import {
    adbShell,
    androidBounds,
    copyMobileFramebufferRecording,
    mobileDisplayState,
    mobileRegionFingerprint,
    mobileSemantics,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android.ts';
import { seedMobileChangesFixture } from './mobile-changes-fixture.ts';
import type { ScenarioEnvironment } from './mobile-conversation-scenarios.ts';
import {
    capture,
    conversationFixture,
    finish,
    openConversation,
    requireRemoteVideoPath,
} from './mobile-conversation-scenarios.ts';
import {
    conversationBaselineRecords,
    conversationLongToolRecords,
} from './mobile-conversation-transcript.ts';
import { panelTransitions, readRecordingBand } from './mobile-motion-analysis.ts';
import { sessionSideTabCheckId } from './mobile-session-panel.ts';

type SemanticNodes = Awaited<ReturnType<typeof mobileSemantics>>;

const boundsOf = (nodes: SemanticNodes, id: string) => {
    const node = nodes.find(({ checkId }) => checkId === id);
    const bounds = node && androidBounds(node.bounds);
    if (!bounds) throw new Error(`Mobile control ${id} has no visible bounds`);
    return bounds;
};

const pause = (ms: number) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * Lets an entering or exiting animation finish inside the recording before the next action.
 */
const SETTLE_MS = 800;

/**
 * Records the Session side panel opening and its tab switches, which avoid the Terminal content switch whose frames
 * need the Terminal fixture preflight. The side panel drawer slides in from the right over the Conversation, and each
 * later tab slides in inside the drawer from the side the selection moved toward, by tab order: Changes, then the Files
 * view (#1280). The recording itself is analysed, because a panel that only appears after its animation has finished
 * still passes every semantic check. Closing the drawer is not analysed: it slides out over a Conversation that never
 * moves, so the band holds no settled panel to measure an offset against.
 */
async function tabSwitching(environment: ScenarioEnvironment, artifacts: string[]) {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        mode: 'conversation',
        seedProject: (root) => seedMobileChangesFixture(root, 'standard'),
        serial,
    });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        if (!fixture.allowedSessionId || !fixture.appendTranscript)
            throw new Error('Synthetic Conversation fixture is incomplete');
        await fixture.appendTranscript(conversationBaselineRecords());
        await fixture.pair();
        await openConversation(serial, fixture.allowedSessionId);
        await pause(SETTLE_MS);
        /**
         * The panel region excludes the header, whose running spinner never stops, and the composer below it. The
         * drawer that later covers the Session spans this region too, so its body is analysed in the same band.
         */
        const body = boundsOf(await mobileSemantics(serial), 'conversation-view');
        const remoteVideoPath = requireRemoteVideoPath();
        recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        await pause(SETTLE_MS);
        await capture(environment, 'conversation', artifacts);
        const panels = {
            changes: { body: 'changes-summary', tab: sessionSideTabCheckId('changes') },
            conversation: { body: 'conversation-view', tab: null },
            files: { body: 'panels-view', tab: sessionSideTabCheckId('caxri.files') },
        } as const;
        /**
         * The first entry is the drawer itself opening on Changes, from the header button; the others are tab switches
         * inside it. The Conversation stays mounted under the open drawer, and screen readers skip it, but uiautomator
         * still lists its body, so only a tab switch waits for the previous body to leave.
         */
        const transitions = [
            { direction: 'from-right', segment: 'changes' },
            { direction: 'from-right', segment: 'files' },
            { direction: 'from-left', segment: 'changes' },
            { direction: 'from-right', segment: 'files' },
            { direction: 'from-left', segment: 'changes' },
        ] as const;
        let current: keyof typeof panels = 'conversation';
        for (const [index, { segment }] of transitions.entries()) {
            const previous = panels[current].body;
            const { body, tab } = panels[segment];
            // eslint-disable-next-line no-await-in-loop -- each tab switch starts from the previous settled panel.
            await tapMobileCheck(serial, index === 0 ? 'session-panel-button' : tab);
            // eslint-disable-next-line no-await-in-loop -- the next capture must follow this panel's render.
            await waitForMobile(
                () => mobileSemantics(serial),
                (nodes) =>
                    hasCheck(nodes, body) &&
                    (index === 0 || !hasCheck(nodes, previous)) &&
                    nodes.some(({ checkId, selected }) => checkId === tab && selected),
            );
            // eslint-disable-next-line no-await-in-loop -- the entering animation finishes before the capture.
            await pause(SETTLE_MS);
            // eslint-disable-next-line no-await-in-loop -- captures are sequential device reads.
            await capture(environment, `${index + 1}-${segment}`, artifacts);
            current = segment;
        }
        await recording.stop();
        recording = undefined;
        const analysis = await mkdtemp(join(tmpdir(), 'caxri-motion-'));
        try {
            const video = join(analysis, 'tab-switching.mp4');
            await copyMobileFramebufferRecording(serial, remoteVideoPath, video);
            const { frames, geometry, scale } = await readRecordingBand(video, body);
            const observed = panelTransitions(frames, geometry);
            const entries = observed.map(({ entry }) => entry);
            const expected = transitions.map(({ direction }) => direction);
            if (JSON.stringify(entries) !== JSON.stringify(expected))
                throw new Error(
                    `Tab switch panels entered as ${entries.join(', ')}; expected ${expected.join(', ')}`,
                );
            await finish(environment, artifacts, {
                recordingBoundary: 'conversation-through-last-tab-switch',
                status: 'passed',
                transitions: transitions.map(({ segment }, index) => ({
                    entry: observed[index].entry,
                    /**
                     * Largest offset from the settled panel seen while it entered, in device pixels.
                     */
                    maxOffsetPx:
                        Math.max(...observed[index].displacements.map((shift) => Math.abs(shift))) *
                        scale,
                    movingFrames: observed[index].displacements.length,
                    segment,
                })),
            });
        } finally {
            await rm(analysis, { force: true, recursive: true });
        }
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}

/**
 * Opens a tool whose output is longer than the tool detail sheet: the sheet stays within its 65% height cap with the
 * Close button visible, and the output scrolls inside it (#1280).
 */
async function longToolDetail(environment: ScenarioEnvironment, artifacts: string[]) {
    const { serial } = environment;
    const fixture = await conversationFixture(serial);
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        await fixture.appendTranscript(conversationLongToolRecords());
        await fixture.pair();
        recording = await startMobileFramebufferRecording(serial, requireRemoteVideoPath());
        await openConversation(serial, fixture.allowedSessionId);
        const listed = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(
                    ({ checkId }) =>
                        checkId.startsWith('conversation-tool-') &&
                        checkId !== 'conversation-tool-detail',
                ),
        );
        const tool = listed.find(
            ({ checkId }) =>
                checkId.startsWith('conversation-tool-') && checkId !== 'conversation-tool-detail',
        )!.checkId;
        await tapMobileCheck(serial, tool);
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                hasCheck(nodes, 'conversation-tool-detail') &&
                hasCheck(nodes, 'tool-detail-scroll') &&
                hasCheck(nodes, 'tool-detail-close'),
        );
        await pause(SETTLE_MS);
        const opened = await mobileSemantics(serial);
        const sheet = boundsOf(opened, 'conversation-tool-detail');
        const close = boundsOf(opened, 'tool-detail-close');
        const body = boundsOf(opened, 'tool-detail-scroll');
        const display = await mobileDisplayState(serial);
        const screenHeight = (display.size.override ?? display.size.physical).height;
        if (sheet.bottom - sheet.top > screenHeight * 0.66)
            throw new Error('The tool detail sheet is taller than its 65% cap');
        if (close.top < sheet.top || close.bottom > sheet.bottom)
            throw new Error('The tool detail Close button is outside the sheet');
        if (body.top < close.bottom || body.bottom > sheet.bottom || body.bottom - body.top < 200)
            throw new Error('The tool detail output is not laid out inside the sheet');
        await capture(environment, 'opened', artifacts);
        const outputFrames = [await mobileRegionFingerprint(serial, body)];

        const x = Math.round((body.left + body.right) / 2);
        const labels = ['scrolled', 'scrolled-end'] as const;
        for (const label of labels) {
            // eslint-disable-next-line no-await-in-loop -- each swipe continues from the previous scroll position.
            await adbShell(serial, [
                'input',
                'swipe',
                String(x),
                String(Math.round(body.top + (body.bottom - body.top) * 0.85)),
                String(x),
                String(Math.round(body.top + (body.bottom - body.top) * 0.15)),
                '500',
            ]);
            // eslint-disable-next-line no-await-in-loop -- the scroll settles before the sheet is measured again.
            await pause(1200);
            // eslint-disable-next-line no-await-in-loop -- the sheet must neither move nor close while its body scrolls.
            const current = await mobileSemantics(serial);
            const moved = boundsOf(current, 'conversation-tool-detail');
            if (moved.top !== sheet.top || moved.bottom !== sheet.bottom)
                throw new Error('Scrolling the tool output moved the sheet');
            // eslint-disable-next-line no-await-in-loop -- only the output region is compared between swipes.
            outputFrames.push(await mobileRegionFingerprint(serial, body));
            // eslint-disable-next-line no-await-in-loop -- captures are sequential device reads.
            await capture(environment, label, artifacts);
        }
        if (new Set(outputFrames).size !== outputFrames.length)
            throw new Error('The tool detail output did not scroll inside the sheet');

        await tapMobileCheck(serial, 'tool-detail-close');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                !hasCheck(nodes, 'conversation-tool-detail') &&
                hasCheck(nodes, 'conversation-view'),
        );
        await pause(SETTLE_MS);
        await capture(environment, 'closed', artifacts);
        await recording.stop();
        recording = undefined;
        await finish(environment, artifacts, {
            closeButton: 'inside-sheet',
            output: 'scrolled-twice-inside-sheet',
            sheetHeightRatio: Math.round(((sheet.bottom - sheet.top) / screenHeight) * 100) / 100,
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}

/**
 * Records the #1280 motion and sheet interactions that earlier Acceptance rounds only reviewed statically (#1297).
 */
export async function executeMobileMotionScenario(
    environment: ScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    switch (environment.caseId) {
        case 'MOB-MOTION-01':
            await tabSwitching(environment, artifacts);
            break;
        case 'MOB-MOTION-03':
            await longToolDetail(environment, artifacts);
            break;
        default:
            throw new Error(`Unsupported motion Acceptance case: ${environment.caseId}`);
    }
}
