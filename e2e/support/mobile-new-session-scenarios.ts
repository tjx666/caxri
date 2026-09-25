import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomic } from '../../scripts/atomic-json';
import { allowE2EErrors, expect } from './fixtures';
import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import {
    captureMobileFramebuffer,
    mobileSemantics,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';
import { conversationBaselineRecords } from './mobile-conversation-transcript';
import { createMobileDesktopCapture } from './mobile-desktop-capture';
import { assertMobileComposerFocused } from './mobile-unicode-input';

interface NewSessionEnvironment {
    artifactManifestPath: string;
    assetsDirectory: string;
    caseId: string;
    launchId: string;
    remoteVideoPath?: string;
    scenarioReceiptPath: string;
    serial: string;
    sourceCommit: string;
}

async function capture(
    environment: NewSessionEnvironment,
    label: string,
    artifacts: string[],
): Promise<void> {
    const name = `${environment.caseId}-${label}-android.png`;
    await captureMobileFramebuffer(environment.serial, join(environment.assetsDirectory, name));
    artifacts.push(`assets/${name}`);
}

async function finish(
    environment: NewSessionEnvironment,
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

async function chooseAgentForAllowedProject(
    environment: NewSessionEnvironment,
    allowedProjectId: string,
    deniedProjectId: string,
    agent: 'claude' | 'codex',
): Promise<void> {
    await tapMobileCheck(environment.serial, 'new-session-button');
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) =>
            nodes.some(({ checkId }) => checkId === 'new-session-screen') &&
            nodes.some(({ checkId }) => checkId === `new-session-project-${allowedProjectId}`) &&
            nodes.every(({ checkId }) => checkId !== `new-session-project-${deniedProjectId}`) &&
            nodes.some(
                ({ checkId, enabled }) => checkId === `new-session-agent-${agent}` && enabled,
            ),
    );
    await tapMobileCheck(environment.serial, `new-session-project-${allowedProjectId}`);
    await tapMobileCheck(environment.serial, `new-session-agent-${agent}`);
}

async function waitForCreatedConversation(serial: string): Promise<void> {
    try {
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId === 'session-detail') &&
                nodes.some(({ checkId }) => checkId === 'session-composer-input') &&
                nodes.some(({ checkId }) => checkId === 'conversation-status-empty') &&
                nodes.every(({ checkId }) => checkId !== 'terminal-live-webview'),
        );
    } catch (error) {
        const nodes = await mobileSemantics(serial);
        const checks = new Set(nodes.map(({ checkId }) => checkId));
        const observed = {
            composer: checks.has('session-composer-input'),
            conversationEmpty: checks.has('conversation-status-empty'),
            conversationLoading: checks.has('conversation-status-loading'),
            conversationView: checks.has('conversation-view'),
            detail: checks.has('session-detail'),
            fallback: checks.has('conversation-fallback-banner'),
            newSessionScreen: checks.has('new-session-screen'),
            terminal: checks.has('terminal-live-webview'),
        };
        throw new Error(`Created Conversation did not become ready: ${JSON.stringify(observed)}`, {
            cause: error,
        });
    }
}

async function executeSuccessfulCreate(
    environment: NewSessionEnvironment,
    artifacts: string[],
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'conversation',
        serial: environment.serial,
    });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    let isStopped = false;
    try {
        if (!fixture.appendTranscript)
            throw new Error('Synthetic Conversation transcript fixture is unavailable');
        await fixture.appendTranscript(conversationBaselineRecords());
        await fixture.pair();
        const desktop = await createMobileDesktopCapture({
            assetsDirectory: environment.assetsDirectory,
            caseId: environment.caseId,
            launchId: environment.launchId,
            profileDirectory: join(fixture.testDirectory, 'user-data'),
            running: fixture.running,
            serial: environment.serial,
            sourceCommit: environment.sourceCommit,
        });
        const before = await pageRequest<{
            selectedSessionId?: string;
            sessions: Array<{ id: string }>;
        }>(fixture.running.page, 'app.bootstrap');
        if (!before.selectedSessionId) throw new Error('Desktop Session selection is unavailable');
        await desktop.capture('before');
        if (environment.caseId === 'MOB-CROSS-01') {
            if (!environment.remoteVideoPath)
                throw new Error('Cross-device Android recording path is unavailable');
            recording = await startMobileFramebufferRecording(
                environment.serial,
                environment.remoteVideoPath,
            );
        }
        await chooseAgentForAllowedProject(
            environment,
            fixture.allowedProjectId,
            fixture.deniedProjectId,
            'claude',
        );
        await capture(environment, 'selection', artifacts);
        await tapMobileCheck(environment.serial, 'new-session-create');
        await waitForCreatedConversation(environment.serial);
        await assertMobileComposerFocused(environment.serial);
        const after = await pageRequest<{
            selectedSessionId?: string;
            sessions: Array<{ id: string }>;
        }>(fixture.running.page, 'app.bootstrap');
        expect(after.selectedSessionId).toBe(before.selectedSessionId);
        expect(after.sessions.length).toBe(before.sessions.length + 1);
        await capture(environment, 'created', artifacts);
        await recording?.stop();
        recording = undefined;
        await desktop.capture('after');
        await fixture.stop();
        isStopped = true;
        await desktop.finalizeAfterCleanup({ cleanupConfirmed: true });
        await finish(environment, artifacts, {
            agent: 'synthetic-Claude',
            composer: 'focused',
            desktopSelection: 'preserved',
            pairing: 'verified-before-media',
            status: 'passed',
        });
    } finally {
        try {
            await recording?.stop();
        } finally {
            if (!isStopped) await fixture.stop();
        }
    }
}

async function executeLaunchFailure(
    environment: NewSessionEnvironment,
    artifacts: string[],
): Promise<void> {
    allowE2EErrors([
        { source: 'server-core', event: 'pty.spawn_failed', code: 'UNAVAILABLE', count: 1 },
    ]);
    const fixture = await createMobileAcceptanceFixture({
        mode: 'launch-failure',
        serial: environment.serial,
    });
    try {
        await fixture.pair();
        await chooseAgentForAllowedProject(
            environment,
            fixture.allowedProjectId,
            fixture.deniedProjectId,
            'codex',
        );
        await fixture.failNextAgentLaunch();
        await tapMobileCheck(environment.serial, 'new-session-create');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId === 'new-session-screen') &&
                nodes.some(({ checkId }) => checkId === 'new-session-create-error') &&
                nodes.some(
                    ({ checkId }) => checkId === `new-session-project-${fixture.allowedProjectId}`,
                ) &&
                nodes.some(({ checkId }) => checkId === 'new-session-agent-codex'),
        );
        await capture(environment, 'launch-failure-selection-retained', artifacts);
        await finish(environment, artifacts, {
            agent: 'synthetic-Codex-launch-failure',
            ...(environment.caseId === 'MOB-PARTIAL-01' && {
                planEvidenceGap: 'creating-progress-frame-unobserved',
            }),
            result: 'error-shown-selection-retained',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * Keeps independent case IDs while using the same isolated product flow for each evidence contract.
 */
export async function executeMobileNewSessionScenario(
    environment: NewSessionEnvironment,
    artifacts: string[],
): Promise<void> {
    switch (environment.caseId) {
        case 'MOB-NEW-01':
        case 'MOB-CROSS-01':
            await executeSuccessfulCreate(environment, artifacts);
            return;
        case 'MOB-NEW-02':
        case 'MOB-PARTIAL-01':
            await executeLaunchFailure(environment, artifacts);
            return;
        default:
            throw new Error(`Unsupported new Session Acceptance case: ${environment.caseId}`);
    }
}
