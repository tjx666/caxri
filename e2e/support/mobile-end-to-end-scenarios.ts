import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTerminalFixturePreflightReceipt } from '../../.agents/skills/acceptance/scripts/fixture-preflight';
import { writeJsonAtomic } from '../../scripts/atomic-json';
import { expect } from './fixtures';
import { pageRequest } from './helpers';
import type { MobileAcceptanceFixture } from './mobile-acceptance-fixture';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import {
    adbShell,
    captureMobileFramebuffer,
    mobileDisplayState,
    mobileSemantics,
    restoreMobileDisplayState,
    setMobileNetworkAvailable,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';
import { conversationBaselineRecords } from './mobile-conversation-transcript';
import type { MobileDesktopCapture } from './mobile-desktop-capture';
import { createMobileDesktopCapture } from './mobile-desktop-capture';
import { tapTerminalKey } from './mobile-terminal-key';
import { assertMobileComposerFocused, setMobileComposerUnicode } from './mobile-unicode-input';

interface JourneyEnvironment {
    artifactManifestPath: string;
    assetsDirectory: string;
    caseId: string;
    launchId: string;
    remoteVideoPath?: string;
    scenarioReceiptPath: string;
    serial: string;
    sourceCommit: string;
}

type JourneyFixture = MobileAcceptanceFixture & {
    allowedSessionId: string;
    appendTranscript(records: unknown[]): Promise<void>;
    journey: NonNullable<MobileAcceptanceFixture['journey']>;
};

function requireJourneyFixture(
    fixture: MobileAcceptanceFixture,
): asserts fixture is JourneyFixture {
    if (!fixture.allowedSessionId || !fixture.appendTranscript || !fixture.journey)
        throw new Error('Synthetic integrated journey fixture is incomplete');
}

async function capture(
    environment: JourneyEnvironment,
    label: string,
    artifacts: string[],
    requiredCheckId: string,
): Promise<void> {
    const nodes = await mobileSemantics(environment.serial);
    if (nodes.every(({ checkId }) => checkId !== requiredCheckId))
        throw new Error(`Integrated journey did not reach ${requiredCheckId}`);
    const name = `${environment.caseId}-${label}-android.png`;
    await captureMobileFramebuffer(environment.serial, join(environment.assetsDirectory, name));
    artifacts.push(`assets/${name}`);
}

async function finish(
    environment: JourneyEnvironment,
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

export function countByteSequence(source: Buffer, target: Buffer): number {
    let count = 0;
    for (
        let offset = source.indexOf(target);
        offset !== -1;
        offset = source.indexOf(target, offset + target.length)
    )
        count += 1;
    return count;
}

async function waitForDesktopConversationGrid(
    fixture: JourneyFixture,
    phase: 'busy' | 'menu',
    selected?: number,
) {
    const surface = fixture.running.page.locator(
        `.terminal-pane[data-terminal-id="${fixture.journey.conversationTerminalId}"] .terminal-surface`,
    );
    await expect(surface).toHaveAttribute('data-terminal-attached', 'true');
    return waitForMobile(
        async () => ({
            grid: await surface.getAttribute('data-terminal-grid'),
            renderedRows: await surface.locator('.xterm-rows > div').allTextContents(),
            state: await fixture.journey.conversationMenuState(),
        }),
        ({ grid, renderedRows, state }) =>
            state?.phase === phase &&
            (selected === undefined || state.selected === selected) &&
            grid === `${state.cols}x${state.rows}` &&
            renderedRows.length === state.rows &&
            renderedRows[0]?.startsWith(`│${state.generation} `) &&
            renderedRows.every((line, index) => line === state.lines[index]),
    );
}

async function writeReadyTerminalPreflight(
    environment: JourneyEnvironment,
    observed: Awaited<ReturnType<typeof waitForDesktopConversationGrid>>,
): Promise<void> {
    const state = observed.state;
    if (!state || state.cols === null || state.rows === null)
        throw new Error('Synthetic journey Terminal grid is unavailable');
    const receipt = createTerminalFixturePreflightReceipt(
        {
            columns: state.cols,
            domRowCount: observed.renderedRows.length,
            firstGridMarker: state.firstGridMarker,
            generation: state.generation,
            lines: observed.renderedRows,
            rows: state.rows,
        },
        environment.caseId,
        { launchId: environment.launchId, sourceCommit: environment.sourceCommit },
    );
    if (receipt.result.status !== 'ready')
        throw new Error('Integrated journey Terminal fixture preflight was blocked');
    await writeJsonAtomic(
        join(environment.assetsDirectory, `${environment.caseId}-fixture-preflight.json`),
        receipt,
    );
}

/**
 * Rechecks the exact Desktop grid after pairing so the receipt describes the frame before media.
 */
async function preflightConversationTerminal(
    environment: JourneyEnvironment,
    fixture: JourneyFixture,
    expectedGeneration?: string,
): Promise<string> {
    const observed = await waitForDesktopConversationGrid(fixture, 'busy');
    const state = observed.state;
    if (!state) throw new Error('Synthetic journey Terminal grid is unavailable');
    if (expectedGeneration && state.generation !== expectedGeneration)
        throw new Error('Synthetic journey Terminal grid changed during mobile pairing');
    await writeReadyTerminalPreflight(environment, observed);
    return state.generation;
}

async function prepareFixture(
    environment: JourneyEnvironment,
    shouldPreflightTerminal: boolean,
): Promise<{ fixture: JourneyFixture; preflightGeneration?: string }> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'journey',
        serial: environment.serial,
    });
    try {
        requireJourneyFixture(fixture);
        await fixture.appendTranscript(conversationBaselineRecords());
        const preflightGeneration = shouldPreflightTerminal
            ? await preflightConversationTerminal(environment, fixture)
            : undefined;
        return { fixture, preflightGeneration };
    } catch (error) {
        await fixture.stop();
        throw error;
    }
}

async function openConversation(
    environment: JourneyEnvironment,
    fixture: JourneyFixture,
): Promise<void> {
    await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) => nodes.some(({ checkId }) => checkId === 'session-detail'),
    );
    await tapMobileCheck(environment.serial, 'session-segment-conversation');
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) =>
            nodes.some(({ checkId }) => checkId === 'conversation-view') &&
            nodes.some(({ checkId }) => checkId.startsWith('conversation-agent-')),
    );
}

async function openOriginalSession(
    environment: JourneyEnvironment,
    fixture: JourneyFixture,
): Promise<void> {
    const nodes = await mobileSemantics(environment.serial);
    if (nodes.every(({ checkId }) => checkId !== `session-row-${fixture.allowedSessionId}`)) {
        await tapMobileCheck(environment.serial, 'session-detail-back');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (current) =>
                current.some(
                    ({ checkId }) => checkId === `session-row-${fixture.allowedSessionId}`,
                ),
        );
    }
    await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (current) => current.some(({ checkId }) => checkId === 'session-detail'),
    );
}

async function runCoreJourney(
    environment: JourneyEnvironment,
    fixture: JourneyFixture,
    artifacts: string[],
): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    await capture(environment, 'home', artifacts, 'session-list');
    await openConversation(environment, fixture);
    await capture(environment, 'conversation', artifacts, 'conversation-view');

    const message = '继续处理合成示例。\n请给出下一步。';
    await setMobileComposerUnicode(environment.serial, message);
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) =>
            nodes.some(({ checkId, enabled }) => checkId === 'session-composer-send' && enabled),
    );
    await tapMobileCheck(environment.serial, 'session-composer-send');
    const expected = Buffer.from(`\u{1B}[200~${message}\u{1B}[201~\r`, 'utf8');
    await waitForMobile(
        () => fixture.readCapturedInput(),
        (input) => countByteSequence(input, expected) === 1,
    );
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) => nodes.some(({ checkId }) => checkId === 'session-composer-stop'),
    );
    await tapMobileCheck(environment.serial, 'session-composer-stop');
    await waitForMobile(
        () => fixture.journey.conversationMenuState(),
        (state) => state?.phase === 'menu' && state.interrupts === 1,
    );
    await capture(environment, 'stopped', artifacts, 'session-detail');

    await tapMobileCheck(environment.serial, 'session-segment-terminal');
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) =>
            nodes.some(({ checkId }) => checkId === 'terminal-live-webview') &&
            nodes.some(({ checkId, enabled }) => checkId === 'terminal-take-over' && enabled),
    );
    const surface = fixture.running.page.locator(
        `.terminal-pane[data-terminal-id="${fixture.journey.conversationTerminalId}"] .terminal-surface`,
    );
    await expect(surface).toHaveAttribute('data-terminal-attached', 'true');
    await capture(environment, 'terminal-observing', artifacts, 'terminal-live-webview');
    await tapMobileCheck(environment.serial, 'terminal-take-over');
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) => nodes.some(({ checkId }) => checkId === 'terminal-release'),
    );
    await tapTerminalKey(environment.serial, 'down');
    await waitForMobile(
        () => fixture.journey.conversationMenuState(),
        (state) => state?.selected === 2,
    );
    await tapTerminalKey(environment.serial, 'enter');
    await waitForMobile(
        () => fixture.journey.conversationMenuState(),
        (state) => state?.submissions === 1,
    );
    await capture(environment, 'terminal-selection', artifacts, 'terminal-live-webview');
    await tapMobileCheck(environment.serial, 'terminal-release');
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) => nodes.some(({ checkId }) => checkId === 'terminal-take-over'),
    );
    await fixture.journey.seedChanges();

    const before = await pageRequest<{
        selectedSessionId?: string;
        sessions: Array<{ id: string }>;
    }>(fixture.running.page, 'app.bootstrap');
    if (before.selectedSessionId !== fixture.allowedSessionId)
        throw new Error('Desktop Session selection changed before mobile Session creation');
    const visible = await mobileSemantics(environment.serial);
    if (visible.every(({ checkId }) => checkId !== 'new-session-button')) {
        await tapMobileCheck(environment.serial, 'session-detail-back');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'new-session-button'),
        );
    }
    await tapMobileCheck(environment.serial, 'new-session-button');
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) =>
            nodes.some(
                ({ checkId }) => checkId === `new-session-project-${fixture.allowedProjectId}`,
            ) &&
            nodes.some(({ checkId, enabled }) => checkId === 'new-session-agent-claude' && enabled),
    );
    await tapMobileCheck(environment.serial, `new-session-project-${fixture.allowedProjectId}`);
    await tapMobileCheck(environment.serial, 'new-session-agent-claude');
    await tapMobileCheck(environment.serial, 'new-session-create');
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) =>
            nodes.some(({ checkId }) => checkId === 'session-detail') &&
            nodes.some(({ checkId }) => checkId === 'session-composer-input') &&
            nodes.some(({ checkId }) => checkId === 'conversation-status-empty') &&
            nodes.every(
                ({ checkId }) =>
                    checkId !== 'terminal-live-webview' &&
                    checkId !== 'conversation-fallback-banner',
            ),
    );
    await assertMobileComposerFocused(environment.serial);
    const after = await waitForMobile(
        () =>
            pageRequest<{ selectedSessionId?: string; sessions: Array<{ id: string }> }>(
                fixture.running.page,
                'app.bootstrap',
            ),
        (state) => state.sessions.length === before.sessions.length + 1,
    );
    expect(after.selectedSessionId).toBe(before.selectedSessionId);
    await capture(environment, 'new-session', artifacts, 'session-detail');

    await openOriginalSession(environment, fixture);
    await tapMobileCheck(environment.serial, 'session-segment-changes');
    const changes = await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) =>
            nodes.some(({ checkId }) => checkId === 'changes-summary') &&
            nodes.filter(({ checkId }) => /^changes-file-row-\d+$/u.test(checkId)).length === 3,
    );
    await capture(environment, 'changes-list', artifacts, 'changes-summary');
    const firstRow = changes.find(({ checkId }) => checkId === 'changes-file-row-0');
    if (!firstRow) throw new Error('Synthetic Changes first row is unavailable');
    await tapMobileCheck(environment.serial, firstRow.checkId);
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) => nodes.some(({ checkId }) => checkId === 'changes-diff-scroll'),
    );
    await capture(environment, 'changes-diff', artifacts, 'changes-diff-scroll');
    return {
        changedFiles: 3,
        desktopSelection: 'preserved',
        durationMs: Date.now() - startedAt,
        menuSelections: 1,
        newSessions: 1,
        submittedMessages: 1,
        terminal: 'same-Session-and-PTY',
    };
}

async function executeMainJourney(
    environment: JourneyEnvironment,
    artifacts: string[],
    isTablet: boolean,
): Promise<void> {
    const { fixture, preflightGeneration } = await prepareFixture(environment, true);
    let originalDisplay: Awaited<ReturnType<typeof mobileDisplayState>> | undefined;
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    let desktop: MobileDesktopCapture | undefined;
    let isDesktopRecordingStarted = false;
    let isStopped = false;
    try {
        if (isTablet) originalDisplay = await mobileDisplayState(environment.serial);
        await fixture.pair();
        if (!preflightGeneration)
            throw new Error('Integrated journey Terminal preflight generation is unavailable');
        await preflightConversationTerminal(environment, fixture, preflightGeneration);
        if (isTablet) {
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
                () => mobileSemantics(environment.serial),
                (nodes) => nodes.some(({ checkId }) => checkId === 'session-list'),
            );
        }
        desktop = isTablet
            ? undefined
            : await createMobileDesktopCapture({
                  assetsDirectory: environment.assetsDirectory,
                  caseId: environment.caseId,
                  launchId: environment.launchId,
                  profileDirectory: join(fixture.testDirectory, 'user-data'),
                  running: fixture.running,
                  serial: environment.serial,
                  sourceCommit: environment.sourceCommit,
              });
        await desktop?.capture('before');
        await desktop?.startRecording();
        isDesktopRecordingStarted = desktop !== undefined;
        let recordingStartedAt = 0;
        if (!isTablet) {
            if (!environment.remoteVideoPath)
                throw new Error('Integrated journey Android recording path is unavailable');
            recording = await startMobileFramebufferRecording(
                environment.serial,
                environment.remoteVideoPath,
            );
            recordingStartedAt = Date.now();
        }
        const result = await runCoreJourney(environment, fixture, artifacts);
        if (isTablet) {
            await waitForMobile(
                () => mobileSemantics(environment.serial),
                (nodes) =>
                    nodes.some(({ checkId }) => checkId === 'session-list') &&
                    nodes.some(({ checkId }) => checkId === 'changes-right-pane'),
            );
        }
        await recording?.stop();
        recording = undefined;
        const recordingDurationMs = recordingStartedAt
            ? Date.now() - recordingStartedAt
            : undefined;
        if (recordingDurationMs !== undefined && recordingDurationMs > 170_000)
            throw new Error('Integrated journey exceeded the bounded Android recording window');
        await desktop?.stopRecording();
        isDesktopRecordingStarted = false;
        await desktop?.capture('after');
        await fixture.stop();
        isStopped = true;
        await desktop?.finalizeAfterCleanup({ cleanupConfirmed: true });
        await finish(environment, artifacts, {
            ...result,
            ...(recordingDurationMs !== undefined && { recordingDurationMs }),
            layout: isTablet ? 'wide-tablet' : 'phone',
            pairing: 'verified-before-media',
            status: 'passed',
        });
    } finally {
        await cleanupMainFixture(environment.serial, fixture, {
            isStopped,
            desktop,
            isDesktopRecordingStarted,
            originalDisplay,
            recording,
        });
    }
}

async function cleanupMainFixture(
    serial: string,
    fixture: JourneyFixture,
    resources: {
        desktop: MobileDesktopCapture | undefined;
        isDesktopRecordingStarted: boolean;
        isStopped: boolean;
        originalDisplay: Awaited<ReturnType<typeof mobileDisplayState>> | undefined;
        recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    },
): Promise<void> {
    const media = await Promise.allSettled([
        resources.recording?.stop() ?? Promise.resolve(),
        resources.isDesktopRecordingStarted
            ? (resources.desktop?.stopRecording() ?? Promise.resolve())
            : Promise.resolve(),
    ]);
    const state = await Promise.allSettled([
        resources.originalDisplay
            ? restoreMobileDisplayState(serial, resources.originalDisplay)
            : Promise.resolve(),
        resources.isStopped ? Promise.resolve() : fixture.stop(),
    ]);
    const failed = [...media, ...state].find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
}

async function executeFailureJourney(
    environment: JourneyEnvironment,
    artifacts: string[],
): Promise<void> {
    const isTerminalPreflight = environment.caseId === 'MOB-E2E-02D';
    const { fixture, preflightGeneration } = await prepareFixture(environment, isTerminalPreflight);
    let isNetworkMayBeDisabled = false;
    try {
        const paired = await fixture.pair();
        if (isTerminalPreflight) {
            if (!preflightGeneration)
                throw new Error('Terminal observation preflight generation is unavailable');
            await preflightConversationTerminal(environment, fixture, preflightGeneration);
        }
        await openConversation(environment, fixture);
        switch (environment.caseId) {
            case 'MOB-E2E-02A': {
                const originalSessionId = fixture.allowedSessionId;
                const originalRecordId = (await mobileSemantics(environment.serial)).find(
                    ({ checkId }) => checkId.startsWith('conversation-agent-'),
                )?.checkId;
                if (!originalRecordId)
                    throw new Error('Original synthetic Conversation identity is unavailable');
                await adbShell(environment.serial, ['input', 'keyevent', 'KEYCODE_HOME']);
                const backgroundedAt = Date.now();
                await new Promise((resolve) => setTimeout(resolve, 15_000));
                await adbShell(environment.serial, [
                    'am',
                    'start',
                    '-W',
                    'com.caxri.mobile/.MainActivity',
                ]);
                const foregroundAt = Date.now();
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'session-detail') &&
                        nodes.some(({ checkId }) => checkId === 'conversation-view') &&
                        nodes.some(({ checkId }) => checkId === originalRecordId) &&
                        nodes.every(({ checkId }) => checkId !== 'connection-stale-banner'),
                    30_000,
                );
                await tapMobileCheck(environment.serial, 'session-detail-back');
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === `session-row-${originalSessionId}`),
                );
                await tapMobileCheck(environment.serial, `session-row-${originalSessionId}`);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'session-detail') &&
                        nodes.some(({ checkId }) => checkId === 'conversation-view') &&
                        nodes.some(({ checkId }) => checkId === originalRecordId),
                );
                await capture(environment, 'foreground-recovered', artifacts, 'session-detail');
                await finish(environment, artifacts, {
                    backgroundDurationMs: foregroundAt - backgroundedAt,
                    recovery: 'same-synthetic-conversation-and-session-id',
                    status: 'passed',
                    timelineIdentity: 'same-safe-record-id',
                });
                break;
            }
            case 'MOB-E2E-02B': {
                const disconnectedAt = Date.now();
                isNetworkMayBeDisabled = true;
                await setMobileNetworkAvailable(environment.serial, false);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'connection-stale-banner'),
                    7_000,
                );
                await capture(environment, 'network-stale', artifacts, 'connection-stale-banner');
                await setMobileNetworkAvailable(environment.serial, true);
                isNetworkMayBeDisabled = false;
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'session-detail') &&
                        nodes.every(({ checkId }) => checkId !== 'connection-stale-banner'),
                    30_000,
                );
                await capture(environment, 'network-recovered', artifacts, 'session-detail');
                await finish(environment, artifacts, {
                    recovery: 'automatic-without-restart',
                    recoveryDurationMs: Date.now() - disconnectedAt,
                    status: 'passed',
                });
                break;
            }
            case 'MOB-E2E-02C': {
                const originalSessionId = fixture.allowedSessionId;
                const revokedAt = Date.now();
                await pageRequest(fixture.running.page, 'mobile.device.revoke', {
                    deviceId: paired.deviceId,
                });
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'pairing-entry-screen') &&
                        nodes.every(
                            ({ checkId }) =>
                                checkId !== 'session-detail' &&
                                checkId !== 'conversation-view' &&
                                checkId !== `session-row-${originalSessionId}`,
                        ),
                    7_000,
                );
                await expect(
                    tapMobileCheck(environment.serial, `session-row-${originalSessionId}`),
                ).rejects.toThrow();
                await capture(environment, 'revoked', artifacts, 'pairing-entry-screen');
                await finish(environment, artifacts, {
                    access: 'revoked',
                    revocationDurationMs: Date.now() - revokedAt,
                    staleSessionAccess: 'unavailable',
                    status: 'passed',
                });
                break;
            }
            case 'MOB-E2E-02D': {
                const terminalId = fixture.journey.conversationTerminalId;
                const identity = await pageRequest<{
                    sessions: Array<{ id: string; primaryAgentTerminalId?: string }>;
                    terminals: Array<{
                        agentSessionId?: string;
                        id: string;
                        sessionId: string;
                    }>;
                }>(fixture.running.page, 'app.bootstrap');
                const session = identity.sessions.find(({ id }) => id === fixture.allowedSessionId);
                const terminal = identity.terminals.find(({ id }) => id === terminalId);
                expect(session?.primaryAgentTerminalId).toBe(terminalId);
                expect(terminal?.sessionId).toBe(fixture.allowedSessionId);
                expect(terminal?.agentSessionId).toBeTruthy();
                const before = await waitForDesktopConversationGrid(fixture, 'busy');
                if (!before.state) throw new Error('Desktop Terminal state disappeared');
                await tapMobileCheck(environment.serial, 'session-composer-stop');
                await waitForMobile(
                    () => fixture.journey.conversationMenuState(),
                    (state) => state?.phase === 'menu' && state.interrupts === 1,
                );
                const passive = await waitForDesktopConversationGrid(fixture, 'menu', 1);
                if (!passive.state) throw new Error('Passive Desktop Terminal grid disappeared');
                expect(passive.state.generation).not.toBe(before.state.generation);
                await writeReadyTerminalPreflight(environment, passive);
                await tapMobileCheck(environment.serial, 'session-segment-terminal');
                const surface = fixture.running.page.locator(
                    `.terminal-pane[data-terminal-id="${terminalId}"] .terminal-surface`,
                );
                await expect(surface).toHaveAttribute('data-terminal-attached', 'true');
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'session-detail') &&
                        nodes.some(({ checkId }) => checkId === 'terminal-live-view') &&
                        nodes.some(({ checkId }) => checkId === 'terminal-live-webview') &&
                        nodes.some(({ checkId }) => checkId === 'terminal-take-over'),
                );
                await capture(
                    environment,
                    'terminal-passive-observation',
                    artifacts,
                    'terminal-live-webview',
                );
                const passiveReadback = await waitForDesktopConversationGrid(fixture, 'menu', 1);
                if (!passiveReadback.state)
                    throw new Error('Passive Desktop Terminal state disappeared');
                expect(passiveReadback.state.generation).toBe(passive.state.generation);
                expect(passiveReadback.state.cols).toBe(passive.state.cols);
                expect(passiveReadback.state.rows).toBe(passive.state.rows);
                await expect(surface).toHaveAttribute('data-terminal-attached', 'true');
                await tapMobileCheck(environment.serial, 'terminal-take-over');
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'terminal-release'),
                );
                await tapTerminalKey(environment.serial, 'down');
                await waitForMobile(
                    () => fixture.journey.conversationMenuState(),
                    (state) =>
                        state?.phase === 'menu' && state.selected === 2 && state.interrupts === 1,
                );
                await expect(surface).toHaveAttribute('data-terminal-attached', 'true');
                await waitForMobile(
                    () => surface.locator('.xterm-rows > div').allTextContents(),
                    (rows) => rows.some((line) => line.includes('> 2. Second')),
                );
                await capture(
                    environment,
                    'simultaneous-terminal',
                    artifacts,
                    'terminal-live-webview',
                );
                await tapMobileCheck(environment.serial, 'terminal-release');
                const restored = await waitForDesktopConversationGrid(fixture, 'menu', 2);
                if (!restored.state)
                    throw new Error('Desktop Terminal did not restore after release');
                expect(restored.state.cols).toBe(passive.state.cols);
                expect(restored.state.rows).toBe(passive.state.rows);
                await finish(environment, artifacts, {
                    desktopAttachment: 'preserved',
                    gridAfter: { columns: restored.state.cols, rows: restored.state.rows },
                    gridBefore: { columns: passive.state.cols, rows: passive.state.rows },
                    gridGenerationAfter: restored.state.generation,
                    gridGenerationBefore: passive.state.generation,
                    mobileChecks: [
                        'terminal-live-view',
                        'terminal-live-webview',
                        'terminal-release',
                    ],
                    status: 'passed',
                    terminalIdentity: 'same-Session-and-PTY',
                });
                break;
            }
            default:
                throw new Error(
                    `Unsupported integrated journey failure case: ${environment.caseId}`,
                );
        }
    } finally {
        await cleanupFailureFixture(environment.serial, fixture, isNetworkMayBeDisabled);
    }
}

async function cleanupFailureFixture(
    serial: string,
    fixture: JourneyFixture,
    isNetworkMayBeDisabled: boolean,
): Promise<void> {
    const cleanup = await Promise.allSettled([
        ...(isNetworkMayBeDisabled ? [setMobileNetworkAvailable(serial, true)] : []),
        fixture.stop(),
    ]);
    const failed = cleanup.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
}

/**
 * One isolated Desktop lifecycle and one encrypted Project grant belong to each report-bound case.
 */
export async function executeMobileEndToEndScenario(
    environment: JourneyEnvironment,
    artifacts: string[],
): Promise<void> {
    if (environment.caseId === 'MOB-E2E-01')
        return executeMainJourney(environment, artifacts, false);
    if (environment.caseId === 'MOB-E2E-03')
        return executeMainJourney(environment, artifacts, true);
    return executeFailureJourney(environment, artifacts);
}
