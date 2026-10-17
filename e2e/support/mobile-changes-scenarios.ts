import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { writeJsonAtomic } from '../../scripts/atomic-json';
import { expect } from './fixtures';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import {
    adbShell,
    androidBounds,
    captureMobileFramebuffer,
    mobileDisplayState,
    mobileSemantics,
    restoreMobileDisplayState,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';
import { seedMobileChangesFixture } from './mobile-changes-fixture';
import { conversationBaselineRecords } from './mobile-conversation-transcript';
import { assertMobileComposerDraft } from './mobile-unicode-input';

interface ChangesScenarioEnvironment {
    artifactManifestPath: string;
    assetsDirectory: string;
    caseId: string;
    scenarioReceiptPath: string;
    serial: string;
}

const commitPrompt = 'Commit the current changes with a clear message.';

async function safeChangesSemantics(serial: string) {
    const nodes = await mobileSemantics(serial);
    if (nodes.some(({ checkId }) => checkId === 'terminal-live-webview')) {
        throw new Error(
            'Changes Acceptance cannot capture a Terminal frame without fixture preflight',
        );
    }
    return nodes;
}

async function waitForChanges(serial: string) {
    return waitForMobile(
        () => safeChangesSemantics(serial),
        (nodes) =>
            nodes.some(({ checkId }) => checkId === 'changes-view') &&
            nodes.some(({ checkId }) => checkId === 'changes-summary') &&
            nodes.some(({ checkId }) => checkId === 'changes-file-row-0'),
    );
}

/**
 * Swipes inside the diff viewport to avoid Android's edge-back gesture.
 *
 * @see https://developer.android.com/develop/ui/views/touch-and-input/gestures/gesturenav
 */
async function swipeDiffHorizontally(serial: string): Promise<void> {
    const scroll = (await safeChangesSemantics(serial)).find(
        ({ checkId }) => checkId === 'changes-diff-scroll',
    );
    const bounds = scroll && androidBounds(scroll.bounds);
    if (!bounds) throw new Error('Synthetic diff scroll viewport is unavailable');
    const y = Math.floor((bounds.top + bounds.bottom) / 2);
    const width = bounds.right - bounds.left;
    await adbShell(serial, [
        'input',
        'swipe',
        String(Math.floor(bounds.left + width * 0.75)),
        String(y),
        String(Math.floor(bounds.left + width * 0.25)),
        String(y),
        '300',
    ]);
}

async function openChanges(
    serial: string,
    sessionId: string,
    shouldShowConversationBesideChanges: boolean,
): Promise<void> {
    await tapMobileCheck(serial, `session-row-${sessionId}`);
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => nodes.some(({ checkId }) => checkId === 'session-segment-changes'),
    );
    if (shouldShowConversationBesideChanges) {
        await tapMobileCheck(serial, 'session-segment-conversation');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId === 'conversation-view') &&
                nodes.some(({ checkId }) => checkId.startsWith('conversation-user-')),
        );
    }
    await tapMobileCheck(serial, 'session-segment-changes');
    await waitForChanges(serial);
}

async function capture(
    environment: ChangesScenarioEnvironment,
    label: string,
    artifacts: string[],
    requiredId: string,
): Promise<void> {
    const nodes = await safeChangesSemantics(environment.serial);
    if (nodes.every(({ checkId }) => checkId !== requiredId)) {
        throw new Error(`Changes Acceptance did not reach ${requiredId}`);
    }
    const name = `${environment.caseId}-${label}-android.png`;
    await captureMobileFramebuffer(environment.serial, join(environment.assetsDirectory, name));
    artifacts.push(`assets/${name}`);
}

async function finish(
    environment: ChangesScenarioEnvironment,
    artifacts: string[],
    receipt: Record<string, unknown>,
): Promise<void> {
    await Promise.all([
        writeJsonAtomic(environment.artifactManifestPath, { artifacts, schemaVersion: 1 }),
        writeFile(
            environment.scenarioReceiptPath,
            `${JSON.stringify({ ...receipt, caseId: environment.caseId, schemaVersion: 1 }, null, 2)}\n`,
            'utf8',
        ),
    ]);
}

function changedRowIds(nodes: Awaited<ReturnType<typeof mobileSemantics>>): string[] {
    return nodes
        .map(({ checkId }) => checkId)
        .filter((checkId) => /^changes-file-row-\d+$/u.test(checkId));
}

function countByteSequence(source: Buffer, target: Buffer): number {
    let count = 0;
    for (
        let offset = source.indexOf(target);
        offset !== -1;
        offset = source.indexOf(target, offset + target.length)
    ) {
        count += 1;
    }
    return count;
}

async function captureUnreviewableDiffs(
    environment: ChangesScenarioEnvironment,
    artifacts: string[],
): Promise<number> {
    const rowIds = changedRowIds(await waitForChanges(environment.serial));
    expect(rowIds).toHaveLength(2);
    let placeholders = 0;
    for (const rowId of rowIds) {
        // eslint-disable-next-line no-await-in-loop -- each diff navigation depends on returning to the list.
        await tapMobileCheck(environment.serial, rowId);
        // eslint-disable-next-line no-await-in-loop -- this observation determines whether this row is unreviewable.
        const nodes = await waitForMobile(
            () => safeChangesSemantics(environment.serial),
            (current) =>
                current.some(({ checkId }) => checkId === 'changes-too-large') ||
                current.some(({ checkId }) => checkId === 'changes-diff-scroll'),
        );
        if (nodes.some(({ checkId }) => checkId === 'changes-too-large')) {
            placeholders += 1;
            // eslint-disable-next-line no-await-in-loop -- one screenshot belongs to this exact synthetic file.
            await capture(
                environment,
                `unreviewable-${placeholders}`,
                artifacts,
                'changes-too-large',
            );
        }
        // eslint-disable-next-line no-await-in-loop -- the next file must open from the list.
        await tapMobileCheck(environment.serial, 'changes-diff-back');
        // eslint-disable-next-line no-await-in-loop -- wait for the previous diff to leave the screen.
        await waitForChanges(environment.serial);
    }
    return placeholders;
}

/**
 * Runs the four frozen synthetic mobile Changes scenarios.
 */
export async function executeMobileChangesScenario(
    environment: ChangesScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const isLimits = environment.caseId === 'MOB-CHANGES-02';
    const fixture = await createMobileAcceptanceFixture({
        mode: environment.caseId === 'MOB-CHANGES-04' ? 'waiting' : 'conversation',
        seedProject: (root) => seedMobileChangesFixture(root, isLimits ? 'limits' : 'standard'),
        serial: environment.serial,
    });
    let originalDisplay: Awaited<ReturnType<typeof mobileDisplayState>> | undefined;
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        if (environment.caseId === 'MOB-CHANGES-03') {
            if (!fixture.appendTranscript)
                throw new Error('Synthetic tablet Conversation fixture is unavailable');
            await fixture.appendTranscript(conversationBaselineRecords());
            originalDisplay = await mobileDisplayState(environment.serial);
        }
        await fixture.pair();
        const sessionId = fixture.allowedSessionId;
        if (!sessionId) throw new Error('Synthetic Changes Session is unavailable');
        if (originalDisplay) {
            await adbShell(environment.serial, ['wm', 'size', '2560x1600']);
            await adbShell(environment.serial, ['wm', 'density', '240']);
            await adbShell(environment.serial, ['am', 'force-stop', 'com.caxri.mobile']);
            await adbShell(environment.serial, [
                'am',
                'start',
                '-W',
                'com.caxri.mobile/.MainActivity',
            ]);
            await waitForMobile(
                () => safeChangesSemantics(environment.serial),
                (nodes) => nodes.some(({ checkId }) => checkId === `session-row-${sessionId}`),
            );
        }
        await openChanges(environment.serial, sessionId, environment.caseId === 'MOB-CHANGES-03');
        switch (environment.caseId) {
            case 'MOB-CHANGES-01': {
                const rows = changedRowIds(await safeChangesSemantics(environment.serial));
                expect(rows).toHaveLength(3);
                await capture(environment, 'three-files', artifacts, 'changes-summary');
                await tapMobileCheck(environment.serial, rows[0]);
                await waitForMobile(
                    () => safeChangesSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'changes-diff-scroll'),
                );
                await capture(environment, 'text-diff', artifacts, 'changes-diff-scroll');
                await swipeDiffHorizontally(environment.serial);
                await waitForMobile(
                    () => safeChangesSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'changes-diff-scroll'),
                );
                await capture(
                    environment,
                    'text-diff-after-horizontal-swipe',
                    artifacts,
                    'changes-diff-scroll',
                );
                await finish(environment, artifacts, {
                    changedFiles: 3,
                    diff: 'synthetic-text-rendered',
                    status: 'passed',
                });
                break;
            }
            case 'MOB-CHANGES-02': {
                // The 3,000-line oversized file proves compact counts (`+3k`) in the list.
                await capture(environment, 'limits-list', artifacts, 'changes-summary');
                const placeholders = await captureUnreviewableDiffs(environment, artifacts);
                expect(placeholders).toBe(2);
                await finish(environment, artifacts, {
                    binaryAndOversized: 'both-show-placeholder',
                    status: 'passed',
                });
                break;
            }
            case 'MOB-CHANGES-03': {
                await waitForMobile(
                    () => safeChangesSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'session-list') &&
                        nodes.some(({ checkId }) => checkId === 'conversation-view') &&
                        nodes.some(({ checkId }) => checkId === 'changes-right-pane'),
                );
                await capture(
                    environment,
                    'wide-tablet-third-pane',
                    artifacts,
                    'changes-right-pane',
                );
                await finish(environment, artifacts, {
                    layout: 'list-detail-changes',
                    status: 'passed',
                });
                break;
            }
            case 'MOB-CHANGES-04': {
                const remoteVideoPath = process.env.CAXRI_MOBILE_ACCEPTANCE_REMOTE_VIDEO_PATH;
                if (!remoteVideoPath)
                    throw new Error('Scenario-owned Android recording path is unavailable');
                expect((await fixture.readCapturedInput()).length).toBe(0);
                recording = await startMobileFramebufferRecording(
                    environment.serial,
                    remoteVideoPath,
                );
                await tapMobileCheck(environment.serial, 'changes-ask-agent-commit');
                await assertMobileComposerDraft(environment.serial, commitPrompt);
                expect((await fixture.readCapturedInput()).length).toBe(0);
                await safeChangesSemantics(environment.serial);
                await tapMobileCheck(environment.serial, 'session-composer-send');
                const expected = Buffer.from(`\u{1B}[200~${commitPrompt}\u{1B}[201~\r`, 'utf8');
                await waitForMobile(
                    () => fixture.readCapturedInput(),
                    (input) => countByteSequence(input, expected) === 1,
                );
                await waitForMobile(
                    () => safeChangesSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'session-composer-feedback') &&
                        nodes.some(
                            ({ checkId }) =>
                                checkId === 'session-composer-stop' ||
                                checkId === 'session-composer-send',
                        ),
                );
                const finalInput = await fixture.readCapturedInput();
                const deliveryCount = countByteSequence(finalInput, expected);
                expect(deliveryCount).toBe(1);
                expect(finalInput.equals(expected)).toBe(true);
                await recording.stop();
                recording = undefined;
                await finish(environment, artifacts, {
                    beforeSend: 'draft-only',
                    afterSend: 'delivered-once-to-synthetic-agent',
                    deliveryCount,
                    status: 'passed',
                });
                break;
            }
            default:
                throw new Error(`Unsupported Changes Acceptance case: ${environment.caseId}`);
        }
    } finally {
        try {
            await recording?.stop();
        } finally {
            try {
                if (originalDisplay)
                    await restoreMobileDisplayState(environment.serial, originalDisplay);
            } finally {
                await fixture.stop();
            }
        }
    }
}
