import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { checkBounds, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileSemantics,
    observeMobileNode,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';
import { insertMobileInputUnicode } from './mobile-unicode-input';

/**
 * Sends that each race a newline against the Send tap. The race depends on scheduling, so one round tries several
 * times.
 */
const ATTEMPTS = 6;

/**
 * `MOB-CHAT-CLEAR-01` (#3463): a Chat message sent while the keyboard is still writing into the composer leaves the
 * composer empty. Each attempt types a Chinese draft through the fixture IME, then fires Enter and a tap on Send from
 * one device shell so the newline reaches the native field while the phone is clearing it. Before the fix the native
 * field refused the clear as stale and handed the sent text, plus the newline, back to the draft.
 */
export async function executeMobileChatClearAfterSendScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        const outcomes: Array<'cleared' | 'restored'> = [];
        for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
            const text = `缓存不收钱，另一家不清楚 ${attempt}`;
            // eslint-disable-next-line no-await-in-loop -- each attempt starts from the previous turn's end.
            await insertMobileInputUnicode(serial, 'agent-chat-composer-input', text, text);
            // eslint-disable-next-line no-await-in-loop -- the button is read once the draft enables it.
            const send = checkBounds(await mobileSemantics(serial), 'agent-chat-composer-send');
            if (!send) throw new Error('Send is not laid out');
            const x = Math.floor((send.left + send.right) / 2);
            const y = Math.floor((send.top + send.bottom) / 2);
            // eslint-disable-next-line no-await-in-loop -- see above.
            await adbShell(serial, [`input keyevent KEYCODE_ENTER & input tap ${x} ${y}; wait`]);
            // eslint-disable-next-line no-await-in-loop -- see above.
            await waitForMobile(
                () => chat.read(),
                (snapshot) =>
                    !snapshot.activeTurnId &&
                    snapshot.items.some(
                        (item) => item.type === 'userMessage' && item.text.trim() === text,
                    ),
                60_000,
            );
            // eslint-disable-next-line no-await-in-loop -- see above.
            await waitForNoCheck(serial, 'agent-chat-activity');
            // eslint-disable-next-line no-await-in-loop -- see above.
            const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
                kind: 'includes',
                value: text,
            });
            const outcome = draft.textMatches ? 'restored' : 'cleared';
            outcomes.push(outcome);
            if (outcome === 'restored') {
                // eslint-disable-next-line no-await-in-loop -- see above.
                await capture(environment, `restored-${attempt}`, artifacts);
                break;
            }
        }
        await capture(environment, 'composer-after-sends', artifacts);
        const restored = outcomes.filter((outcome) => outcome === 'restored').length;
        await finish(environment, artifacts, {
            attempts: outcomes.length,
            restored,
            status: restored === 0 ? 'passed' : 'failed',
        });
        if (restored > 0)
            throw new Error(`The composer took back a sent message in ${restored} attempt`);
    } finally {
        await fixture.stop();
    }
}
