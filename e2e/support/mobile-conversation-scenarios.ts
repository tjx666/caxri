import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { createTerminalFixturePreflightReceipt } from '../../.agents/skills/acceptance/scripts/fixture-preflight.ts';
import { writeJsonAtomic } from '../../scripts/atomic-json.ts';
import { allowE2EErrors } from './error-gate.ts';
import { expect } from './fixtures.ts';
import { pageRequest } from './helpers.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture.ts';
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
} from './mobile-android.ts';
import {
    conversationAgentRecords,
    conversationBaselineRecords,
} from './mobile-conversation-transcript.ts';

interface ScenarioEnvironment {
    artifactManifestPath: string;
    assetsDirectory: string;
    caseId: string;
    scenarioReceiptPath: string;
    serial: string;
}

const remoteVideoPath = process.env.CAXRI_MOBILE_ACCEPTANCE_REMOTE_VIDEO_PATH;

function opaqueDigest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function itemIdDigests(items: Array<{ id: string }>): string[] {
    return items.map(({ id }) => opaqueDigest(id));
}

async function capture(
    environment: ScenarioEnvironment,
    label: string,
    artifacts: string[],
): Promise<void> {
    const name = `${environment.caseId}-${label}-android.png`;
    await captureMobileFramebuffer(environment.serial, join(environment.assetsDirectory, name));
    artifacts.push(`assets/${name}`);
}

async function finish(
    environment: ScenarioEnvironment,
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

function requireRemoteVideoPath(): string {
    if (!remoteVideoPath) throw new Error('Scenario-owned Android recording path is unavailable');
    return remoteVideoPath;
}

async function conversationFixture(serial: string) {
    const fixture = await createMobileAcceptanceFixture({ mode: 'conversation', serial });
    if (
        !fixture.allowedSessionId ||
        !fixture.appendTranscript ||
        !fixture.readTimeline ||
        !fixture.pairTimelineGateway ||
        !fixture.replaceTranscript
    ) {
        await fixture.stop();
        throw new Error('Synthetic Conversation fixture is incomplete');
    }
    return {
        ...fixture,
        allowedSessionId: fixture.allowedSessionId,
        appendTranscript: (records: unknown[]) => fixture.appendTranscript!(records),
        pairTimelineGateway: () => fixture.pairTimelineGateway!(),
        readTimeline: () => fixture.readTimeline!(),
        replaceTranscript: (records: unknown[]) => fixture.replaceTranscript!(records),
    };
}

async function openConversation(serial: string, sessionId: string): Promise<void> {
    await tapMobileCheck(serial, `session-row-${sessionId}`);
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => nodes.some(({ checkId }) => checkId === 'session-detail'),
    );
    await tapMobileCheck(serial, 'session-segment-conversation');
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => nodes.some(({ checkId }) => checkId === 'conversation-view'),
    );
}

async function waitForConversationId(serial: string, prefix: string): Promise<string> {
    const nodes = await waitForMobile(
        () => mobileSemantics(serial),
        (current) => current.some(({ checkId }) => checkId.startsWith(prefix)),
    );
    return nodes.find(({ checkId }) => checkId.startsWith(prefix))!.checkId;
}

async function scrollToConversationId(
    serial: string,
    prefix: string,
    direction: 'earlier' | 'later',
): Promise<string> {
    const viewport = (await mobileSemantics(serial)).find(
        ({ checkId }) => checkId === 'conversation-view',
    );
    const frame = viewport && androidBounds(viewport.bounds);
    if (!frame) throw new Error('Conversation scroll viewport is unavailable');
    const x = Math.floor((frame.left + frame.right) / 2);
    const upper = frame.top + Math.floor((frame.bottom - frame.top) * 0.25);
    const lower = frame.top + Math.floor((frame.bottom - frame.top) * 0.8);
    for (let attempt = 0; attempt < 8; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- each gesture depends on the currently rendered virtual list.
        const nodes = await mobileSemantics(serial);
        const match = nodes.find(({ checkId }) => checkId.startsWith(prefix));
        if (match) return match.checkId;
        // eslint-disable-next-line no-await-in-loop -- one bounded gesture advances the same viewport.
        await adbShell(serial, [
            'input',
            'swipe',
            String(x),
            String(direction === 'earlier' ? upper : lower),
            String(x),
            String(direction === 'earlier' ? lower : upper),
            '300',
        ]);
    }
    throw new Error(`Conversation item ${prefix} was not rendered after bounded scrolling`);
}

async function assertConversationContentDuringPause(serial: string): Promise<void> {
    const deadline = Date.now() + 2_500;
    let blankSince: number | undefined;
    do {
        // eslint-disable-next-line no-await-in-loop -- consecutive observations detect a sustained virtual-list blank.
        const nodes = await mobileSemantics(serial);
        if (nodes.some(({ checkId }) => checkId.startsWith('conversation-agent-'))) {
            blankSince = undefined;
        } else {
            blankSince ??= Date.now();
            if (Date.now() - blankSince >= 900)
                throw new Error('Conversation content remained blank during history scrolling');
        }
        // eslint-disable-next-line no-await-in-loop -- the next sample measures the same stationary viewport.
        await new Promise((resolve) => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
}

async function capturedHash(environment: ScenarioEnvironment, label: string) {
    const frame = await readFile(
        join(environment.assetsDirectory, `${environment.caseId}-${label}-android.png`),
    );
    return createHash('sha256').update(frame).digest('hex');
}

interface ShellGridState {
    columns: number;
    firstGridMarker: { columns: number; generation: string; rows: number };
    generation: string;
    rows: number;
}

async function readShellGridState(path: string): Promise<ShellGridState | null> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as ShellGridState;
    } catch {
        return null;
    }
}

async function preflightSyntheticShell(
    environment: ScenarioEnvironment,
    fixture: Awaited<ReturnType<typeof createMobileAcceptanceFixture>>,
    terminalId: string,
): Promise<string> {
    if (!fixture.allowedSessionId || !fixture.shellGridStatePath)
        throw new Error('Synthetic Shell preflight state is unavailable');
    await pageRequest(fixture.running.page, 'session.select', {
        sessionId: fixture.allowedSessionId,
    });
    const surface = fixture.running.page.locator(
        `.terminal-pane[data-terminal-id="${terminalId}"] .terminal-surface`,
    );
    const statePath = fixture.shellGridStatePath;
    const state = await waitForMobile(
        async () => {
            const grid = await surface.getAttribute('data-terminal-grid');
            const renderedRows = await surface.locator('.xterm-rows > div').allTextContents();
            const marker = await readShellGridState(statePath);
            return { grid, marker, renderedRows };
        },
        ({ grid, marker, renderedRows }) =>
            marker !== null &&
            grid === `${marker.columns}x${marker.rows}` &&
            renderedRows.length === marker.rows &&
            renderedRows.every((line, index) => {
                const label = `Synthetic row ${String(index + 1).padStart(2, '0')}`;
                return line === `│${label.padEnd(marker.columns - 2, ' ')}│`;
            }),
    );
    if (!state.marker) throw new Error('Synthetic Shell grid marker is unavailable');
    const receipt = createTerminalFixturePreflightReceipt(
        {
            columns: state.marker.columns,
            domRowCount: state.renderedRows.length,
            firstGridMarker: state.marker.firstGridMarker,
            generation: state.marker.generation,
            lines: state.renderedRows,
            rows: state.marker.rows,
        },
        environment.caseId,
    );
    if (receipt.result.status !== 'ready')
        throw new Error('Synthetic Shell formal fixture preflight was blocked');
    const name = `${environment.caseId}-fixture-preflight.json`;
    await writeJsonAtomic(join(environment.assetsDirectory, name), receipt);
    return `assets/${name}`;
}

export async function executeMobileConversationScenario(
    environment: ScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    switch (environment.caseId) {
        case 'MOB-TIMELINE-01': {
            const fixture = await conversationFixture(environment.serial);
            let gateway: Awaited<ReturnType<typeof fixture.pairTimelineGateway>> | undefined;
            let subscription: { unsubscribe(): Promise<void> } | undefined;
            try {
                await fixture.appendTranscript(conversationBaselineRecords());
                const androidPairing = await fixture.pair();
                gateway = await fixture.pairTimelineGateway();
                const syntheticDeviceId = gateway.deviceId;
                const pairedDevices = await pageRequest<{
                    devices: Array<{
                        deviceId: string;
                        projectIds: string[];
                        revokedAt?: number;
                    }>;
                }>(fixture.running.page, 'mobile.device.list');
                const activeDevices = pairedDevices.devices.filter(
                    ({ revokedAt }) => revokedAt === undefined,
                );
                const androidGrant = activeDevices.find(
                    ({ deviceId }) => deviceId === androidPairing.deviceId,
                );
                const syntheticGrant = activeDevices.find(
                    ({ deviceId }) => deviceId === syntheticDeviceId,
                );
                if (
                    activeDevices.length !== 2 ||
                    androidPairing.deviceId === syntheticDeviceId ||
                    androidGrant?.projectIds.length !== 1 ||
                    androidGrant.projectIds[0] !== fixture.allowedProjectId ||
                    syntheticGrant?.projectIds.length !== 1 ||
                    syntheticGrant.projectIds[0] !== fixture.allowedProjectId
                ) {
                    throw new Error('Timeline paired-device grants are not isolated');
                }
                const first = await gateway.readTimeline({
                    sessionId: fixture.allowedSessionId,
                    limit: 80,
                });
                const second = await gateway.readTimeline({
                    sessionId: fixture.allowedSessionId,
                    limit: 80,
                });
                expect(first.status).toBe('available');
                expect(first.items.map(({ type }) => type)).toEqual([
                    'userMessage',
                    'agentMessage',
                    'toolCall',
                    'toolCall',
                    'turnBoundary',
                ]);
                expect(second.items.map(({ id }) => id)).toEqual(first.items.map(({ id }) => id));
                const newest = await gateway.readTimeline({
                    sessionId: fixture.allowedSessionId,
                    limit: 2,
                });
                if (!newest.olderCursor)
                    throw new Error('Timeline pagination cursor is unavailable');
                const older = await gateway.readTimeline({
                    sessionId: fixture.allowedSessionId,
                    before: newest.olderCursor,
                    limit: 3,
                });
                expect(older.items.map(({ id }) => id)).toEqual(
                    first.items.slice(0, 3).map(({ id }) => id),
                );
                if (!fixture.deniedSessionId)
                    throw new Error('Denied fixture Session is unavailable');
                allowE2EErrors([
                    {
                        source: 'server-core',
                        event: 'ipc.request_failed',
                        code: 'NOT_FOUND',
                        method: 'mobile.timeline.read',
                        count: 1,
                    },
                ]);
                await expect(
                    gateway.readTimeline({
                        sessionId: fixture.deniedSessionId,
                    }),
                ).rejects.toMatchObject({ code: 'NOT_FOUND' });
                await openConversation(environment.serial, fixture.allowedSessionId);
                await scrollToConversationId(environment.serial, 'conversation-user-', 'earlier');
                let changeCount = 0;
                subscription = await gateway.subscribeConversation(
                    fixture.allowedSessionId,
                    (message) => {
                        if (message.kind === 'conversation.changed') changeCount += 1;
                    },
                );
                await fixture.appendTranscript(conversationAgentRecords(10, 1));
                await waitForMobile(
                    () => changeCount,
                    (count) => count > 0,
                );
                const appended = await gateway.readTimeline({
                    sessionId: fixture.allowedSessionId,
                    limit: 80,
                });
                expect(appended.items.length).toBe(first.items.length + 1);
                expect(appended.items.slice(0, first.items.length).map(({ id }) => id)).toEqual(
                    first.items.map(({ id }) => id),
                );
                await fixture.replaceTranscript(conversationAgentRecords(60, 2));
                const rotated = await gateway.readTimeline({
                    sessionId: fixture.allowedSessionId,
                    before: newest.olderCursor,
                    limit: 80,
                });
                expect(rotated.cursorExpired).toBe(true);
                expect(rotated.items).toHaveLength(2);
                const serverLog = await readFile(
                    join(fixture.testDirectory, 'user-data', 'logs', 'server-core.jsonl'),
                    'utf8',
                );
                for (const body of [
                    'Summarize this synthetic sample.',
                    'Synthetic result',
                    'Synthetic update 10.',
                ]) {
                    expect(serverLog).not.toContain(body);
                }
                await finish(environment, artifacts, {
                    appendedCount: appended.items.length - first.items.length,
                    authorizedRead: 'paired-encrypted-gateway',
                    beforeCursorDigest: opaqueDigest(newest.olderCursor),
                    deniedProject: 'not-found',
                    diagnosticLogs: 'synthetic-message-body-absent',
                    idStability: 'unchanged-across-rebuild-and-append',
                    itemIdDigests: {
                        first: itemIdDigests(first.items),
                        repeated: itemIdDigests(second.items),
                        latest: itemIdDigests(newest.items),
                        older: itemIdDigests(older.items),
                        appended: itemIdDigests(appended.items),
                        rotated: itemIdDigests(rotated.items),
                    },
                    itemCount: first.items.length,
                    itemTypes: first.items.map(({ type }) => type),
                    mobileRender: 'allowed-session-conversation',
                    notificationCount: changeCount,
                    olderPageCount: older.items.length,
                    pairedDeviceGrants: {
                        activeCount: activeDevices.length,
                        androidDeviceIdDigest: opaqueDigest(androidPairing.deviceId),
                        syntheticDeviceIdDigest: opaqueDigest(syntheticDeviceId),
                        syntheticAuthorizedProjectCount: syntheticGrant.projectIds.length,
                    },
                    rotation: 'old-cursor-expired',
                    status: 'passed',
                });
            } finally {
                await subscription?.unsubscribe();
                gateway?.close();
                await fixture.stop();
            }
            break;
        }
        case 'MOB-CONV-01': {
            const fixture = await conversationFixture(environment.serial);
            try {
                await fixture.appendTranscript(conversationBaselineRecords());
                await fixture.pair();
                await openConversation(environment.serial, fixture.allowedSessionId);
                await scrollToConversationId(environment.serial, 'conversation-user-', 'earlier');
                await scrollToConversationId(environment.serial, 'conversation-agent-', 'later');
                await scrollToConversationId(environment.serial, 'conversation-group-', 'later');
                await scrollToConversationId(environment.serial, 'conversation-turn-', 'later');
                const group = await scrollToConversationId(
                    environment.serial,
                    'conversation-group-',
                    'earlier',
                );
                await capture(environment, 'collapsed', artifacts);
                await tapMobileCheck(environment.serial, group);
                const tool = await waitForConversationId(environment.serial, 'conversation-tool-');
                await capture(environment, 'expanded', artifacts);
                await tapMobileCheck(environment.serial, tool);
                await waitForConversationId(environment.serial, 'conversation-tool-detail');
                await capture(environment, 'tool-detail', artifacts);
                await finish(environment, artifacts, {
                    screenshots: ['collapsed', 'expanded', 'tool-detail'],
                    states: ['user', 'markdown-code', 'tool-group', 'turn', 'tool-detail'],
                    status: 'passed',
                });
            } finally {
                await fixture.stop();
            }
            break;
        }
        case 'MOB-CONV-02': {
            const fixture = await conversationFixture(environment.serial);
            let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
            try {
                await fixture.appendTranscript(conversationAgentRecords(10, 500));
                await fixture.pair();
                await openConversation(environment.serial, fixture.allowedSessionId);
                recording = await startMobileFramebufferRecording(
                    environment.serial,
                    requireRemoteVideoPath(),
                );
                await fixture.appendTranscript(conversationAgentRecords(510, 1));
                const followed = (await fixture.readTimeline()).items.at(-1);
                if (!followed) throw new Error('Synthetic live Conversation is empty');
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(
                            ({ checkId }) => checkId === `conversation-agent-${followed.id}`,
                        ),
                );
                const conversation = (await mobileSemantics(environment.serial)).find(
                    ({ checkId }) => checkId === 'conversation-view',
                );
                const frame = conversation && androidBounds(conversation.bounds);
                if (!frame) throw new Error('Conversation scroll viewport is unavailable');
                const x = Math.floor((frame.left + frame.right) / 2);
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    // eslint-disable-next-line no-await-in-loop -- each gesture moves the same isolated viewport.
                    await adbShell(environment.serial, [
                        'input',
                        'swipe',
                        String(x),
                        String(frame.top + Math.floor((frame.bottom - frame.top) * 0.25)),
                        String(x),
                        String(frame.top + Math.floor((frame.bottom - frame.top) * 0.8)),
                        '300',
                    ]);
                }
                await fixture.appendTranscript(conversationAgentRecords(511, 1));
                await waitForConversationId(environment.serial, 'conversation-jump-latest');
                await assertConversationContentDuringPause(environment.serial);
                await tapMobileCheck(environment.serial, 'conversation-jump-latest');
                const latest = (await fixture.readTimeline()).items.at(-1);
                if (!latest) throw new Error('Synthetic latest Conversation item is empty');
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(
                            ({ checkId }) => checkId === `conversation-agent-${latest.id}`,
                        ) && nodes.every(({ checkId }) => checkId !== 'conversation-jump-latest'),
                );
                await recording.stop();
                recording = undefined;
                const scrollStartedAt = Date.now();
                for (let attempt = 0; attempt < 10; attempt += 1) {
                    // eslint-disable-next-line no-await-in-loop -- the next gesture depends on the same visible list.
                    await adbShell(environment.serial, [
                        'input',
                        'swipe',
                        String(x),
                        String(frame.top + Math.floor((frame.bottom - frame.top) * 0.25)),
                        String(x),
                        String(frame.top + Math.floor((frame.bottom - frame.top) * 0.8)),
                        '180',
                    ]);
                }
                await waitForConversationId(environment.serial, 'conversation-view');
                await finish(environment, artifacts, {
                    boundedScrollDurationMs: Date.now() - scrollStartedAt,
                    syntheticHistoryCount: 500,
                    follow: 'bottom-followed',
                    manualScroll: 'jump-to-latest-visible',
                    returnToBottom: 'latest-visible',
                    recordingBoundary: 'after-pairing-and-conversation-open',
                    scrollSmoke: 'ten-swipes-list-remained-responsive',
                    status: 'passed',
                });
            } finally {
                await recording?.stop();
                await fixture.stop();
            }
            break;
        }
        case 'MOB-CONV-03': {
            const fixture = await createMobileAcceptanceFixture({
                mode: 'shell-conversation',
                serial: environment.serial,
            });
            try {
                if (!fixture.allowedSessionId)
                    throw new Error('Synthetic Shell Session is unavailable');
                const bootstrap = await pageRequest<{
                    terminals: Array<{ id: string; kind: string; sessionId: string }>;
                }>(fixture.running.page, 'app.bootstrap');
                const terminal = bootstrap.terminals.find(
                    ({ sessionId }) => sessionId === fixture.allowedSessionId,
                );
                if (terminal?.kind !== 'shell')
                    throw new Error('Conversation fallback did not own a Shell Terminal');
                const preflightReceipt = await preflightSyntheticShell(
                    environment,
                    fixture,
                    terminal.id,
                );
                artifacts.push(preflightReceipt);
                await fixture.pair();
                await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'conversation-fallback-banner') &&
                        nodes.some(({ checkId }) => checkId === 'terminal-live-webview'),
                );
                await capture(environment, 'shell-fallback', artifacts);
                await finish(environment, artifacts, {
                    fallback: 'shell-to-terminal',
                    terminalPrivacyPreflight: 'formal-grid-ready-before-phone-frame',
                    preflightReceipt,
                    status: 'passed',
                });
            } finally {
                await fixture.stop();
            }
            break;
        }
        case 'MOB-CONV-04': {
            const original = await mobileDisplayState(environment.serial);
            const fixture = await conversationFixture(environment.serial);
            try {
                await fixture.appendTranscript(conversationBaselineRecords());
                await fixture.pair();
                await adbShell(environment.serial, ['wm', 'size', '1600x2560']);
                await adbShell(environment.serial, ['wm', 'density', '320']);
                await adbShell(environment.serial, [
                    'settings',
                    'put',
                    'system',
                    'font_scale',
                    '1.0',
                ]);
                await adbShell(environment.serial, ['am', 'force-stop', 'com.caxri.mobile']);
                await adbShell(environment.serial, [
                    'am',
                    'start',
                    '-W',
                    'com.caxri.mobile/.MainActivity',
                ]);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(
                            ({ checkId }) => checkId === `session-row-${fixture.allowedSessionId}`,
                        ),
                );
                await openConversation(environment.serial, fixture.allowedSessionId);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'session-list') &&
                        nodes.some(({ checkId }) => checkId === 'session-detail') &&
                        nodes.some(({ checkId }) => checkId.startsWith('conversation-user-')),
                );
                await capture(environment, 'tablet-split', artifacts);
                await adbShell(environment.serial, [
                    'settings',
                    'put',
                    'system',
                    'font_scale',
                    '1.4',
                ]);
                await adbShell(environment.serial, ['am', 'force-stop', 'com.caxri.mobile']);
                await adbShell(environment.serial, [
                    'am',
                    'start',
                    '-W',
                    'com.caxri.mobile/.MainActivity',
                ]);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(
                            ({ checkId }) => checkId === `session-row-${fixture.allowedSessionId}`,
                        ),
                );
                await openConversation(environment.serial, fixture.allowedSessionId);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'session-list') &&
                        nodes.some(({ checkId }) => checkId === 'session-detail') &&
                        nodes.some(({ checkId }) => checkId.startsWith('conversation-user-')),
                );
                const enlarged = await mobileDisplayState(environment.serial);
                expect(enlarged.fontScale).toBe(1.4);
                await capture(environment, 'tablet-large-font', artifacts);
                const screenshotHashes = {
                    split: await capturedHash(environment, 'tablet-split'),
                    largeFont: await capturedHash(environment, 'tablet-large-font'),
                };
                await restoreMobileDisplayState(environment.serial, original);
                await finish(environment, artifacts, {
                    displayAfter: await mobileDisplayState(environment.serial),
                    displayBefore: original,
                    displayAtLargeFont: enlarged,
                    screenshotHashes,
                    status: 'passed',
                });
            } finally {
                await restoreMobileDisplayState(environment.serial, original);
                await fixture.stop();
            }
            break;
        }
        default:
            throw new Error(`Unsupported Conversation Acceptance case: ${environment.caseId}`);
    }
}
