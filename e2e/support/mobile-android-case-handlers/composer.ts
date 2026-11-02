import { Buffer } from 'node:buffer';

import { expect } from '../fixtures';
import { pageRequest } from '../helpers';
import { createMobileAcceptanceFixture } from '../mobile-acceptance-fixture';
import { capture, finish, openComposerSession } from '../mobile-agent-actions-scenarios';
import { executeMobileChatClearAfterSendScenario } from '../mobile-agent-chat-clear-scenario';
import {
    mobileSemantics,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from '../mobile-android';
import type {
    MobileAndroidCaseEnvironment,
    MobileAndroidCaseHandler,
} from '../mobile-android-case-registry';
import { requireRemoteVideoPath } from '../mobile-android-case-registry';
import { countByteSequence } from '../mobile-end-to-end-scenarios';
import {
    assertMobileComposerDraft,
    assertMobileUnknownFeedback,
    enterComposerText,
} from '../mobile-unicode-input';

async function executeMultilineDelivery(
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'waiting',
        serial: environment.serial,
    });
    const message = '请检查第一项。\n然后继续第二项。';
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        await fixture.pair();
        if (!fixture.allowedSessionId) throw new Error('Composer Session is unavailable');
        await openComposerSession(environment.serial, fixture.allowedSessionId);
        recording = await startMobileFramebufferRecording(
            environment.serial,
            requireRemoteVideoPath(environment),
        );
        await enterComposerText(environment.serial, message, 'compose');
        await capture(environment, 'multiline-draft', artifacts);
        const before = await fixture.readCapturedInput();
        expect(before.length).toBe(0);
        await tapMobileCheck(environment.serial, 'session-composer-send');
        const submitted = Buffer.from(`\u{1B}[200~${message}\u{1B}[201~\r`, 'utf8');
        const captured = await waitForMobile(
            () => fixture.readCapturedInput(),
            (input) => countByteSequence(input, submitted) === 1,
        );
        expect(countByteSequence(captured, submitted)).toBe(1);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId === 'session-composer-feedback') &&
                nodes.some(
                    ({ checkId, enabled }) =>
                        checkId === 'session-composer-stop' ||
                        (checkId === 'session-composer-send' && !enabled),
                ),
        );
        await capture(environment, 'delivered', artifacts);
        await finish(environment, artifacts, {
            draftAfter: 'cleared',
            encodedInput: 'utf8-multiline-once',
            imeInput: 'setComposingText-finishComposingText',
            inputBeforeSend: 'none',
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}

async function executeStopRunningTurn(
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'waiting',
        serial: environment.serial,
    });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        await fixture.pair();
        if (!fixture.allowedSessionId) throw new Error('Composer Session is unavailable');
        await openComposerSession(environment.serial, fixture.allowedSessionId);
        recording = await startMobileFramebufferRecording(
            environment.serial,
            requireRemoteVideoPath(environment),
        );
        await enterComposerText(environment.serial, 'Continue synthetic task');
        await tapMobileCheck(environment.serial, 'session-composer-send');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'session-composer-stop'),
        );
        await capture(environment, 'running-stop', artifacts);
        await tapMobileCheck(environment.serial, 'session-composer-stop');
        await waitForMobile(
            () =>
                pageRequest<{
                    sessions: Array<{ id: string; agentActivityState?: string }>;
                }>(fixture.running.page, 'app.bootstrap'),
            (state) =>
                state.sessions.some(
                    (session) =>
                        session.id === fixture.allowedSessionId &&
                        session.agentActivityState !== 'running',
                ),
        );
        await capture(environment, 'stopped', artifacts);
        await finish(environment, artifacts, {
            action: 'target-Agent-interrupted',
            input: 'empty-at-stop',
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}

async function executeUnknownDeliveryResult(
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        dropSubmitAcknowledgement: true,
        mode: 'waiting',
        serial: environment.serial,
    });
    const message = 'Synthetic uncertain delivery';
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        await fixture.pair();
        if (!fixture.allowedSessionId) throw new Error('Composer Session is unavailable');
        await openComposerSession(environment.serial, fixture.allowedSessionId);
        recording = await startMobileFramebufferRecording(
            environment.serial,
            requireRemoteVideoPath(environment),
        );
        await enterComposerText(environment.serial, message);
        await tapMobileCheck(environment.serial, 'session-composer-send');
        const submitted = Buffer.from(`\u{1B}[200~${message}\u{1B}[201~\r`, 'utf8');
        const captured = await waitForMobile(
            () => fixture.readCapturedInput(),
            (input) => countByteSequence(input, submitted) === 1,
        );
        expect(countByteSequence(captured, submitted)).toBe(1);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'session-composer-feedback'),
        );
        await assertMobileUnknownFeedback(environment.serial);
        await assertMobileComposerDraft(environment.serial, message);
        await capture(environment, 'result-unknown', artifacts);
        await finish(environment, artifacts, {
            draft: 'retained',
            hostWrite: 'once-before-ack-drop',
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}

export const handlers = {
    'MOB-COMPOSER-01': executeMultilineDelivery,
    'MOB-COMPOSER-02': executeStopRunningTurn,
    'MOB-COMPOSER-03': executeUnknownDeliveryResult,
    'MOB-CHAT-CLEAR-01': executeMobileChatClearAfterSendScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
