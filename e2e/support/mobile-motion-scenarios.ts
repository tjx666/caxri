import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pageRequest } from './helpers.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture.ts';
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
import { assertStaysAbsent, swipeRowLeft } from './mobile-ui-audit-scenarios.ts';

type SemanticNodes = Awaited<ReturnType<typeof mobileSemantics>>;

const hasCheck = (nodes: SemanticNodes, id: string): boolean =>
    nodes.some(({ checkId }) => checkId === id);

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
 * Records every Session detail tab switch that avoids the Terminal tab, whose frames need the Terminal fixture
 * preflight. Each new panel slides in from the side the selection moved toward (#1280); the recording itself is
 * analysed, because a panel that only appears after its animation has finished still passes every semantic check.
 */
async function tabSwitching(environment: ScenarioEnvironment, artifacts: string[]) {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        changes: 'standard',
        mode: 'conversation',
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
         * The panel region excludes the header, whose running spinner never stops, and the composer below it.
         */
        const body = boundsOf(await mobileSemantics(serial), 'conversation-view');
        const remoteVideoPath = requireRemoteVideoPath();
        recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        await pause(SETTLE_MS);
        await capture(environment, 'conversation', artifacts);
        const panels = {
            changes: 'changes-summary',
            conversation: 'conversation-view',
            panels: 'panels-view',
        } as const;
        const transitions = [
            { direction: 'from-right', segment: 'changes' },
            { direction: 'from-right', segment: 'panels' },
            { direction: 'from-left', segment: 'conversation' },
            { direction: 'from-right', segment: 'panels' },
            { direction: 'from-left', segment: 'changes' },
        ] as const;
        let current: keyof typeof panels = 'conversation';
        for (const [index, { segment }] of transitions.entries()) {
            const previous = panels[current];
            // eslint-disable-next-line no-await-in-loop -- each tab switch starts from the previous settled panel.
            await tapMobileCheck(serial, `session-segment-${segment}`);
            // eslint-disable-next-line no-await-in-loop -- the next capture must follow this panel's render.
            await waitForMobile(
                () => mobileSemantics(serial),
                (nodes) =>
                    hasCheck(nodes, panels[segment]) &&
                    !hasCheck(nodes, previous) &&
                    nodes.some(
                        ({ checkId, selected }) =>
                            checkId === `session-segment-${segment}` && selected,
                    ),
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
 * Keeps at most one Session row open: opening a second row closes the first, a tap on another row closes the open row
 * without opening a Session, and scrolling the list closes it (#1280).
 */
async function swipeRows(environment: ScenarioEnvironment, artifacts: string[]) {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'conversation', serial });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        /**
         * The list only scrolls when its rows are taller than the phone, so the Project gets extra empty Sessions.
         */
        const created: string[] = [];
        for (let index = 1; index <= 14; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- Sessions are created one at a time in a stable order.
            const { session } = await pageRequest<{ session: { id: string } }>(
                fixture.running.page,
                'session.create',
                { defaultAgent: null, projectId: fixture.allowedProjectId },
            );
            // eslint-disable-next-line no-await-in-loop -- each title follows its own creation.
            await pageRequest(fixture.running.page, 'session.rename', {
                displayTitle: `Synthetic Session ${String(index).padStart(2, '0')}`,
                sessionId: session.id,
            });
            created.push(session.id);
        }
        await fixture.pair();
        const listed = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.filter(({ checkId }) => created.some((id) => checkId === `session-row-${id}`))
                    .length >= 3,
        );
        const rows = listed
            .filter(({ checkId }) => created.some((id) => checkId === `session-row-${id}`))
            .map((node) => ({ bounds: androidBounds(node.bounds), id: node.checkId }))
            .filter(
                (row): row is { bounds: NonNullable<typeof row.bounds>; id: string } =>
                    row.bounds !== null,
            )
            .toSorted((left, right) => left.bounds.top - right.bounds.top);
        if (rows.length < 2) throw new Error('Two synthetic Session rows are not visible');
        const [first, second] = rows;
        const archiveOf = (rowId: string) =>
            rowId.replace('session-row-', 'session-swipe-archive-');
        const openArchives = (nodes: SemanticNodes) =>
            nodes.filter(({ checkId }) => checkId.startsWith('session-swipe-archive-')).length;

        recording = await startMobileFramebufferRecording(serial, requireRemoteVideoPath());
        await pause(SETTLE_MS);
        await swipeRowLeft(serial, first.id);
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => hasCheck(nodes, archiveOf(first.id)),
        );
        await pause(SETTLE_MS);
        await capture(environment, 'first-row-open', artifacts);

        await swipeRowLeft(serial, second.id);
        const secondOpen = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                hasCheck(nodes, archiveOf(second.id)) && !hasCheck(nodes, archiveOf(first.id)),
        );
        if (openArchives(secondOpen) !== 1) throw new Error('More than one Session row is open');
        await pause(SETTLE_MS);
        await capture(environment, 'second-row-open', artifacts);

        /**
         * The tap lands on the first row's title side, which a swipe action never covers.
         */
        await adbShell(serial, [
            'input',
            'tap',
            String(Math.round(first.bounds.left + (first.bounds.right - first.bounds.left) * 0.25)),
            String(Math.round((first.bounds.top + first.bounds.bottom) / 2)),
        ]);
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => openArchives(nodes) === 0 && hasCheck(nodes, first.id),
        );
        await assertStaysAbsent(serial, ['session-detail']);
        await capture(environment, 'tap-closed', artifacts);

        await swipeRowLeft(serial, first.id);
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => hasCheck(nodes, archiveOf(first.id)),
        );
        await pause(SETTLE_MS);
        const list = boundsOf(await mobileSemantics(serial), 'session-list');
        const x = Math.round((list.left + list.right) / 2);
        await adbShell(serial, [
            'input',
            'swipe',
            String(x),
            String(Math.round(list.top + (list.bottom - list.top) * 0.8)),
            String(x),
            String(Math.round(list.top + (list.bottom - list.top) * 0.45)),
            '400',
        ]);
        const scrolled = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => openArchives(nodes) === 0,
        );
        const firstAfterScroll = scrolled.find(({ checkId }) => checkId === first.id);
        const firstTop = firstAfterScroll && androidBounds(firstAfterScroll.bounds)?.top;
        if (firstTop === first.bounds.top) throw new Error('The Session list did not scroll');
        await pause(SETTLE_MS);
        await capture(environment, 'scroll-closed', artifacts);
        await recording.stop();
        recording = undefined;
        await finish(environment, artifacts, {
            openRows: {
                afterSecondSwipe: 1,
                afterTapOnAnotherRow: 0,
                afterListScroll: 0,
            },
            tapOnAnotherRow: 'closed-without-opening-session',
            status: 'passed',
            syntheticSessionCount: created.length,
        });
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
        case 'MOB-MOTION-02':
            await swipeRows(environment, artifacts);
            break;
        case 'MOB-MOTION-03':
            await longToolDetail(environment, artifacts);
            break;
        default:
            throw new Error(`Unsupported motion Acceptance case: ${environment.caseId}`);
    }
}
