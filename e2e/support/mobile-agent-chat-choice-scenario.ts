import type { AgentChatSnapshot, BootstrapState } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    agentText,
    sendFromPhone,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import { openModelSheet, waitForCheckedOptions } from './mobile-agent-chat-model-scenario';
import { mobileSemantics, tapMobileCheckByBounds, waitForMobile } from './mobile-android';

/**
 * The fake Claude Code's `opus` alias reports the full model it resolves to once in use.
 */
const isOpus = (snapshot: AgentChatSnapshot): boolean =>
    snapshot.model === 'opus' || snapshot.model === 'fake-claude-opus';

/**
 * `MOB-CHAT-CHOICE-01` (#3880): a Chat's own model choice stays in sync on the phone and survives a provider restart.
 * Desktop's switch shows on the phone's sheet; the phone's own switch is stored as the Chat's choice; after idle
 * suspension stops the provider, the phone's next message starts it again on that choice; Desktop's Reset to default
 * moves the phone to the global default kept in Claude Code's `settings.json`. Each step is read on the phone's checked
 * options and against the Server's Chat projection, which Desktop's picker reads.
 */
export async function executeMobileChatChoiceScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    try {
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        const { page } = fixture.running;
        const processState = async (): Promise<string | undefined> =>
            (await pageRequest<BootstrapState>(page, 'app.bootstrap')).terminals.find(
                ({ id }) => id === chat.terminalId,
            )?.lastProcessState;
        const steps: Array<{ step: string; model?: string; effort?: string; custom: boolean }> = [];
        /**
         * This Chat's `agent_chat.choice_applied` records for `trigger` that handed the provider the stored model (and
         * the effort, unless the new process already ran on it).
         */
        const choiceApplied = async (
            trigger: 'reset' | 'start',
        ): Promise<Array<Record<string, unknown>>> =>
            (
                await pageRequest<{ records: Array<{ fields?: Record<string, unknown> }> }>(
                    page,
                    'logs.query',
                    { event: 'agent_chat.choice_applied', limit: 100 },
                )
            ).records
                .map(({ fields }) => fields ?? {})
                .filter(
                    (fields) =>
                        fields.terminalId === chat.terminalId &&
                        fields.trigger === trigger &&
                        fields.outcome === 'applied' &&
                        String(fields.keys).split(',').includes('model'),
                );
        const record = (step: string, snapshot: AgentChatSnapshot): void => {
            steps.push({
                step,
                model: snapshot.model,
                effort: snapshot.effort,
                custom: snapshot.customChoice === true,
            });
        };
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId === `session-row-${fixture.allowedSessionId}`),
        );
        await tapMobileCheckByBounds(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => (snapshot.models?.length ?? 0) > 0,
        );

        // 1. Desktop's picker switches the Chat; the phone's sheet follows.
        await chat.configure({ model: 'opus', effort: 'high' });
        record(
            'desktop-switch',
            await waitForMobile(
                () => chat.read(),
                (snapshot) =>
                    isOpus(snapshot) && snapshot.effort === 'high' && !!snapshot.customChoice,
            ),
        );
        await openModelSheet(serial);
        await waitForCheckedOptions(serial, ['agent-chat-model-opus', 'agent-chat-effort-high']);
        await capture(environment, 'desktop-switch-on-phone', artifacts);

        // 2. The phone's own switch becomes the Chat's choice.
        await tapMobileCheckByBounds(serial, 'agent-chat-effort-low');
        record(
            'phone-switch',
            await waitForMobile(
                () => chat.read(),
                (snapshot) =>
                    isOpus(snapshot) && snapshot.effort === 'low' && !!snapshot.customChoice,
            ),
        );
        await waitForCheckedOptions(serial, ['agent-chat-model-opus', 'agent-chat-effort-low']);
        await capture(environment, 'phone-switch', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');
        await waitForNoCheck(serial, 'agent-chat-model-sheet');

        // 3. Idle suspension stops the provider; the phone's next message starts it again on the Chat's choice.
        const { suspended } = await pageRequest<{ suspended: boolean }>(page, 'terminal.suspend', {
            terminalId: chat.terminalId,
        });
        if (!suspended) throw new Error('The Chat provider was not running');
        await waitForMobile(processState, (state) => state === 'suspended');
        record('suspended', await chat.read());
        const restoresBefore = (await choiceApplied('start')).length;
        await sendFromPhone(serial, 'hello');
        const resumed = await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('You said: hello') && !snapshot.activeTurnId,
        );
        if (!isOpus(resumed) || resumed.effort !== 'low' || !resumed.customChoice)
            throw new Error('The restarted Chat lost its own model choice');
        if ((await processState()) !== 'running')
            throw new Error('The Chat provider did not restart');
        /**
         * The restarted provider starts on its own default model, so the snapshot alone could still be the one from
         * before the suspension: the restore's log proves the new process was handed the stored model and effort.
         */
        await waitForMobile(
            () => choiceApplied('start'),
            (records) => records.length > restoresBefore,
        );
        record('after-restart', resumed);
        await waitForNoCheck(serial, 'agent-chat-activity');
        await openModelSheet(serial);
        await waitForCheckedOptions(serial, ['agent-chat-model-opus', 'agent-chat-effort-low']);
        await capture(environment, 'after-restart', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');
        await waitForNoCheck(serial, 'agent-chat-model-sheet');

        // 4. Desktop's Reset to default moves the Chat, and the phone, to the global default.
        await pageRequest<void>(page, 'agentChat.writeDefaults', {
            provider: 'claude',
            model: 'fake-claude-haiku',
        });
        await chat.configure({ resetChoice: true });
        record(
            'desktop-reset',
            await waitForMobile(
                () => chat.read(),
                (snapshot) => snapshot.model === 'fake-claude-haiku' && !snapshot.customChoice,
            ),
        );
        await openModelSheet(serial);
        // The default model offers no effort control, so the sheet lists no effort at all.
        await waitForCheckedOptions(serial, ['agent-chat-model-fake-claude-haiku']);
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => nodes.every(({ checkId }) => !checkId.startsWith('agent-chat-effort-')),
        );
        await capture(environment, 'desktop-reset-on-phone', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');
        await waitForNoCheck(serial, 'agent-chat-model-sheet');

        await finish(environment, artifacts, {
            choiceAfterRestart: 'kept',
            restartRestore: 'applied',
            desktopReset: 'global-default',
            status: 'passed',
            steps,
        });
    } finally {
        await fixture.stop();
    }
}
