import type { AgentChatSnapshot } from '@caxri/protocol';

import type { FakeClaudeScript } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-script.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileSemantics,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

const PROMPT = 'Build the release package';
const NARRATION = 'Packaging now; this takes a while.';

/**
 * A turn whose trailing work is one command that keeps running, so the phone shows that run's live summary.
 */
const script: FakeClaudeScript = {
    turns: [
        {
            prompt: PROMPT,
            steps: [
                { kind: 'text', text: NARRATION },
                {
                    kind: 'tool',
                    name: 'Bash',
                    input: { command: 'sleep 900', description: 'Build the DMG' },
                    output: 'done',
                    durationMs: 900_000,
                },
            ],
        },
    ],
};

const runningCommandId = (snapshot: AgentChatSnapshot): string | undefined =>
    snapshot.activeTurnId
        ? snapshot.items.find((item) => item.type === 'command' && item.status === 'running')?.id
        : undefined;

/**
 * Global animation scales. With the animator off, React Native reports reduced motion, so the running summary's shimmer
 * and the activity spinner hold still and UIAutomator can read the live Chat.
 */
const ANIMATION_SCALES = [
    'animator_duration_scale',
    'transition_animation_scale',
    'window_animation_scale',
];

const setAnimationScales = (serial: string, value: string) =>
    Promise.all(
        ANIMATION_SCALES.map((name) =>
            adbShell(serial, ['settings', 'put', 'global', name, value]),
        ),
    );

/**
 * `MOB-CHAT-SINGLE-WORK-01` (#3325): a running turn whose trailing work is one call keeps its live summary, and that
 * summary used to expand into a single row repeating its own title (`Waiting for agents` under `Waiting for agents`).
 * The summary of one call now opens that call's detail, as Desktop's does.
 */
export async function executeMobileChatSingleWorkScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        claudeScript: script,
        mode: 'agent-chat',
        serial,
    });
    await setAnimationScales(serial, '0');
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await fixture.pair();
        await chat.send({ text: PROMPT });
        const snapshot = await waitForMobile(
            () => chat.read(),
            (current) => runningCommandId(current) !== undefined,
            60_000,
        );
        const commandId = runningCommandId(snapshot);
        if (!commandId) throw new Error('The command never started');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        const group = `agent-chat-work-group-${commandId}`;
        await waitForCheck(serial, group);
        await capture(environment, 'summary', artifacts);

        await tapMobileCheckByBounds(serial, group);
        const opened = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(
                    ({ checkId }) =>
                        checkId === 'conversation-tool-detail' ||
                        checkId === `agent-chat-work-${commandId}`,
                ),
        );
        await capture(environment, 'after-tap', artifacts);
        const outcome = opened.some(({ checkId }) => checkId === 'conversation-tool-detail')
            ? 'detail'
            : 'repeated-row';
        await finish(environment, artifacts, {
            outcome,
            status: outcome === 'detail' ? 'passed' : 'failed',
        });
        if (outcome !== 'detail')
            throw new Error('The one-call summary expanded into a row repeating its title');
    } finally {
        await setAnimationScales(serial, '1');
        await fixture.stop();
    }
}
