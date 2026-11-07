import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
    beginAgentFixtureLifecycle,
    completeAgentFixtureLifecycle,
} from '../../.agents/skills/acceptance/scripts/agent-fixture-lifecycle';
import { writeJsonAtomic } from '../../scripts/atomic-json';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import {
    adbShell,
    androidBounds,
    mobileSemantics,
    observeMobileNode,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';
import {
    addMobileGalleryImages,
    pickMobileGalleryImages,
    removeMobileGalleryImages,
} from './mobile-gallery';
import { captureScenarioFrame } from './mobile-scenario-capture';
import { openSessionSidePanel } from './mobile-session-panel';
import {
    assertMobileComposerDraft,
    insertMobileInputUnicode,
    setMobileComposerUnicode,
} from './mobile-unicode-input';

export interface MobileAgentScenarioEnvironment {
    artifactManifestPath: string;
    assetsDirectory: string;
    caseId: string;
    scenarioReceiptPath: string;
    serial: string;
}

export async function capture(
    environment: MobileAgentScenarioEnvironment,
    label: string,
    artifacts: string[],
): Promise<void> {
    await captureScenarioFrame(environment, label, artifacts);
}

export async function finish(
    environment: MobileAgentScenarioEnvironment,
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

/**
 * Writes the receipt with every missed outcome named in `checks`, then fails the case when any was missed. A scenario
 * that captures every frame before calling it lets a baseline round on the previous build show the same views for
 * comparison and still end with a failed receipt naming what differed.
 */
export async function concludeScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
    receipt: Record<string, unknown>,
    checks: Record<string, boolean>,
): Promise<void> {
    const differences = Object.entries(checks)
        .filter(([, isMet]) => !isMet)
        .map(([name]) => name);
    await finish(environment, artifacts, {
        ...receipt,
        differences,
        status: differences.length === 0 ? 'passed' : 'failed',
    });
    if (differences.length > 0)
        throw new Error(`${environment.caseId} differs: ${differences.join('; ')}`);
}

/**
 * Opens a Session's composer from the phone, the entry every composer case starts from.
 */
export async function openComposerSession(serial: string, sessionId: string): Promise<void> {
    await tapMobileCheck(serial, `session-row-${sessionId}`);
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => nodes.some(({ checkId }) => checkId === 'session-detail'),
    );
    /**
     * The synthetic Agent has no Conversation, so its Session shows the Terminal, with the composer under it for every
     * device that can send.
     */
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => nodes.some(({ checkId }) => checkId === 'session-composer-input'),
    );
}

export async function executeMobileComposerSuggestionsScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
    remoteVideoPath: string,
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'attention',
        serial: environment.serial,
    });
    const reportDirectory = dirname(environment.assetsDirectory);
    const fixtureLaunchId = await beginAgentFixtureLifecycle(reportDirectory, {
        availableProviders: ['claude', 'codex'],
        caseId: environment.caseId,
        fixtureId: 'agent-features-v1',
    });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        const projectRoot = join(fixture.testDirectory, 'allowed-project');
        await mkdir(join(projectRoot, '.claude', 'commands'), { recursive: true });
        await Promise.all([
            writeFile(
                join(projectRoot, '.claude', 'commands', 'acceptance-command.md'),
                'Synthetic command.\n',
            ),
            writeFile(join(projectRoot, 'acceptance-note.txt'), 'Synthetic file.\n'),
        ]);
        await fixture.pair();
        if (!fixture.allowedSessionId) throw new Error('Composer fixture Session is unavailable');
        await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'session-composer-input'),
        );
        recording = await startMobileFramebufferRecording(environment.serial, remoteVideoPath);
        await setMobileComposerUnicode(environment.serial, '/acceptance-command');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'session-composer-suggestion-0'),
        );
        await tapMobileCheck(environment.serial, 'session-composer-suggestion-0');
        await assertMobileComposerDraft(environment.serial, '/acceptance-command ');
        await insertMobileInputUnicode(
            environment.serial,
            'session-composer-input',
            '@acceptance-note',
            '/acceptance-command @acceptance-note',
        );
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'session-composer-suggestion-0'),
        );
        await tapMobileCheck(environment.serial, 'session-composer-suggestion-0');
        await assertMobileComposerDraft(
            environment.serial,
            '/acceptance-command @acceptance-note.txt ',
        );
        await finish(environment, artifacts, {
            actionInserted: true,
            fileInserted: true,
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
        await completeAgentFixtureLifecycle(reportDirectory, {
            caseId: environment.caseId,
            cleanupCompleted: true,
            launchId: fixtureLaunchId,
            sharedProfile: false,
        });
    }
}

export async function executeMobileFileEditScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'attention',
        serial: environment.serial,
    });
    try {
        const filePath = join(fixture.testDirectory, 'allowed-project', 'acceptance-note.txt');
        await writeFile(filePath, '');
        await fixture.pair();
        if (!fixture.allowedSessionId) throw new Error('File edit fixture Session is unavailable');
        await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
        await openSessionSidePanel(environment.serial, 'caxri.files');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'files-entry-acceptance-note.txt'),
        );
        await tapMobileCheck(environment.serial, 'files-entry-acceptance-note.txt');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId, enabled }) => checkId === 'files-edit' && enabled),
        );
        await tapMobileCheck(environment.serial, 'files-edit');
        await insertMobileInputUnicode(environment.serial, 'files-editor', 'accepted', 'accepted');
        await tapMobileCheck(environment.serial, 'files-save');
        await waitForMobile(
            () => readFile(filePath, 'utf8'),
            (content) => content === 'accepted',
        );
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId, enabled }) => checkId === 'files-edit' && enabled),
        );
        await tapMobileCheck(environment.serial, 'files-edit');
        await insertMobileInputUnicode(
            environment.serial,
            'files-editor',
            ' changed',
            'accepted changed',
        );
        await writeFile(filePath, 'external');
        await tapMobileCheck(environment.serial, 'files-save');
        await waitForMobile(
            () =>
                observeMobileNode(environment.serial, 'files-save-error', {
                    kind: 'includes',
                    value: 'changed on your computer',
                }),
            ({ exists, textMatches }) => exists && textMatches === true,
        );
        if ((await readFile(filePath, 'utf8')) !== 'external')
            throw new Error('Mobile conflict overwrote the external file');
        await capture(environment, 'conflict', artifacts);
        await finish(environment, artifacts, {
            conflictPreserved: true,
            savedHash: createHash('sha256').update('accepted').digest('hex'),
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * Opens the Session overflow menu and taps beside it: an outside tap must close the menu without a second press of the
 * overflow button. The menu hangs from the screen's right edge, so the empty space is to its left. A fixed drop below
 * one item stopped being outside once the menu gained rows (Show Terminal) and landed on a lower item instead.
 */
async function dismissSessionMenuOutside(serial: string): Promise<void> {
    await tapMobileCheck(serial, 'session-detail-menu');
    const nodes = await waitForMobile(
        () => mobileSemantics(serial),
        (current) => current.some(({ checkId }) => checkId === 'session-mark-read'),
    );
    const item = nodes.find(({ checkId }) => checkId === 'session-mark-read');
    const bounds = item && androidBounds(item.bounds);
    if (!bounds) throw new Error('Session menu item is unavailable');
    if (bounds.left < 200)
        throw new Error('Session menu leaves no room beside it for an outside tap');
    await adbShell(serial, [
        'input',
        'tap',
        String(Math.floor(bounds.left / 2)),
        String(Math.floor((bounds.top + bounds.bottom) / 2)),
    ]);
    await waitForMobile(
        () => mobileSemantics(serial),
        (current) =>
            current.every(({ checkId }) => checkId !== 'session-mark-read') &&
            current.some(({ checkId }) => checkId === 'session-detail-menu'),
    );
}

export async function executeMobileImageAttachmentScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
    remoteVideoPath: string,
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'attention',
        serial: environment.serial,
    });
    const reportDirectory = dirname(environment.assetsDirectory);
    const fixtureLaunchId = await beginAgentFixtureLifecycle(reportDirectory, {
        availableProviders: ['claude', 'codex'],
        caseId: environment.caseId,
        fixtureId: 'agent-features-v1',
    });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        await addMobileGalleryImages(environment.serial);
        await fixture.pair();
        if (!fixture.allowedSessionId) throw new Error('Image fixture Session is unavailable');
        // Recording starts on the list so the video also shows the screen transition into the Session.
        recording = await startMobileFramebufferRecording(environment.serial, remoteVideoPath);
        await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'session-attach-image'),
        );
        await dismissSessionMenuOutside(environment.serial);
        await tapMobileCheck(environment.serial, 'session-attach-image');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'image-source-cancel'),
        );
        await tapMobileCheck(environment.serial, 'image-source-cancel');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                nodes.every(({ checkId }) => checkId !== 'image-source-sheet') &&
                nodes.some(({ checkId }) => checkId === 'session-attach-image'),
        );
        await tapMobileCheck(environment.serial, 'session-attach-image');
        await tapMobileCheck(environment.serial, 'image-source-library');
        await capture(environment, 'picker', artifacts);
        await pickMobileGalleryImages(environment.serial);
        // A ready thumbnail drops its progress scrim, so the attachment is ready once only its remove control remains.
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId === 'session-image-remove-0') &&
                nodes.every(({ checkId }) => checkId !== 'session-image-status-0'),
        );
        const imageDirectory = join(fixture.testDirectory, 'user-data', 'mobile-attachments');
        const uploaded = await waitForMobile(
            () => readdir(imageDirectory),
            (names) => names.some((name) => /^image_[0-9a-f]{32}\.jpg$/u.test(name)),
        );
        await setMobileComposerUnicode(environment.serial, 'Review image');
        await tapMobileCheck(environment.serial, 'session-composer-send');
        await waitForMobile(
            () =>
                observeMobileNode(environment.serial, 'session-composer-feedback', {
                    kind: 'includes',
                    value: 'Delivered to the Terminal',
                }),
            ({ exists, textMatches }) => exists && textMatches === true,
        );
        await waitForMobile(
            () => fixture.attention!.readReceipt(),
            (receipts) =>
                receipts.some(
                    ({ exists, kind, pathValid }) =>
                        kind === 'imageAttachmentReceived' && exists && pathValid,
                ),
        );
        await finish(environment, artifacts, {
            imageStored: uploaded.length === 1,
            status: 'passed',
            submitted: true,
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
        await removeMobileGalleryImages(environment.serial);
        await completeAgentFixtureLifecycle(reportDirectory, {
            caseId: environment.caseId,
            cleanupCompleted: true,
            launchId: fixtureLaunchId,
            sharedProfile: false,
        });
    }
}
