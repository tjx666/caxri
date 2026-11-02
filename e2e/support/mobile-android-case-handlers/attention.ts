import { dirname } from 'node:path';

import {
    beginAgentFixtureLifecycle,
    completeAgentFixtureLifecycle,
} from '../../../.agents/skills/acceptance/scripts/agent-fixture-lifecycle.ts';
import { createMobileAcceptanceFixture } from '../mobile-acceptance-fixture';
import { capture, finish } from '../mobile-agent-actions-scenarios';
import {
    adbShell,
    mobileSemantics,
    startMobileFramebufferRecording,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from '../mobile-android';
import type {
    MobileAndroidCaseEnvironment,
    MobileAndroidCaseHandler,
} from '../mobile-android-case-registry';
import { requireRemoteVideoPath } from '../mobile-android-case-registry';

async function executeAttentionCase(
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
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
    const kind = environment.caseId === 'MOB-ATTN-01' ? 'permission' : 'question';
    try {
        await fixture.pair();
        if (!fixture.allowedSessionId || !fixture.attention)
            throw new Error('Attention fixture Session is unavailable');
        await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'session-detail'),
        );
        recording = await startMobileFramebufferRecording(
            environment.serial,
            requireRemoteVideoPath(environment),
        );
        await fixture.attention.trigger(
            kind === 'permission' ? 'fixture:permission' : 'fixture:question',
        );
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'attention-cards'),
            30_000,
        );
        await capture(environment, 'request', artifacts);
        if (kind === 'permission') {
            await tapMobileCheck(environment.serial, 'attention-allow-once');
        } else {
            await tapMobileCheckByBounds(environment.serial, 'attention-option-0-0');
            await tapMobileCheckByBounds(environment.serial, 'attention-option-0-1');
            await tapMobileCheckByBounds(environment.serial, 'attention-answer-next');
            await tapMobileCheckByBounds(environment.serial, 'attention-answer-input');
            await adbShell(environment.serial, ['input', 'text', 'fixture']);
            await tapMobileCheckByBounds(environment.serial, 'attention-answer-next');
        }
        await waitForMobile(
            () => fixture.attention!.readReceipt(),
            (receipts) =>
                receipts.some(
                    (receipt) =>
                        receipt.kind === 'attentionAnswer' &&
                        receipt.attentionKind === kind &&
                        receipt.applied === true,
                ),
            30_000,
        );
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                nodes.every(({ checkId }) => checkId !== 'attention-allow-once') &&
                nodes.every(({ checkId }) => checkId !== 'attention-answer-next'),
        );
        await capture(environment, 'answered', artifacts);
        await finish(environment, artifacts, {
            attentionKind: kind,
            fixtureAnswer: 'applied',
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

export const handlers = {
    'MOB-ATTN-01': executeAttentionCase,
    'MOB-ATTN-02': executeAttentionCase,
} satisfies Record<string, MobileAndroidCaseHandler>;
