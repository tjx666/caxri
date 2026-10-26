import type { AgentChatSnapshot } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    chatTimelineFrame,
    hasCheck,
    swipeTimelineTowardEarlier,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileSemantics,
    setMobileNetworkAvailable,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';

/**
 * The newest items the phone's read cache keeps of a Chat (`READ_CACHE_MAX_ITEMS`).
 */
const SAVED_ITEMS = 50;

/**
 * The read cache writes one second after the live view settles; this leaves room for that write before the app dies.
 */
const READ_CACHE_SETTLE_MS = 2_500;

/**
 * How long the reopened Chat is filmed after the live read replaced the saved copy, so a late card would be caught.
 */
const LIVE_SETTLE_MS = 3_000;

const coldStart = async (serial: string): Promise<void> => {
    await adbShell(serial, ['am', 'force-stop', 'com.caxri.mobile']);
    await adbShell(serial, ['am', 'start', '-W', 'com.caxri.mobile/.MainActivity']);
};

const isIdle = (snapshot: AgentChatSnapshot): boolean =>
    !snapshot.activeTurnId && snapshot.turns.every((turn) => turn.status !== 'running');

/**
 * The opened Chat pins its latest turn to the top, so the turn before it sits just above the viewport: one drag toward
 * earlier messages brings its cards into view.
 */
const revealEarlierTurn = async (serial: string): Promise<void> => {
    await swipeTimelineTowardEarlier(serial, await chatTimelineFrame(serial));
};

/**
 * The artifacts turn's item count and how many items came after it.
 */
const split = (snapshot: AgentChatSnapshot, turnId: string) => {
    const first = snapshot.items.findIndex((item) => item.turnId === turnId);
    const last = snapshot.items.findLastIndex((item) => item.turnId === turnId);
    return { after: snapshot.items.length - last - 1, size: last - first + 1 };
};

/**
 * `MOB-CHAT-29`: a Chat whose saved copy would cut a turn that edited files and opened a pull request in half. Reopened
 * online, the phone shows the saved copy and then the live read without that turn's cards appearing late under its
 * reply, which used to push the transcript down for a frame. Offline, the saved copy holds whole turns only.
 */
export async function executeMobileSavedTurnArtifactsScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    let isNetworkDisabled = false;
    try {
        const chat = fixture.agentChat;
        const sessionId = fixture.allowedSessionId;
        if (!chat || !sessionId) throw new Error('Chat fixture is unavailable');
        const row = `session-row-${sessionId}`;

        await chat.send({ text: 'artifacts' });
        const changed = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                isIdle(snapshot) && snapshot.items.some((item) => item.type === 'fileChange'),
        );
        const turnId = changed.items.findLast((item) => item.type === 'fileChange')?.turnId;
        if (!turnId) throw new Error('The artifacts turn did not finish');
        const card = `agent-chat-turn-changes-${turnId}`;

        // One long turn of quick commands follows, so the cache's limit lands inside the artifacts turn while its
        // reply and cards stay just above the long turn's collapsed work.
        const count = changed.items.length;
        await chat.send({ text: 'manysteps' });
        const snapshot = await waitForMobile(
            () => chat.read(),
            (next) =>
                isIdle(next) &&
                next.items.length > count &&
                next.items.at(-1)?.type === 'agentMessage',
        );
        const cut = split(snapshot, turnId);
        if (cut.after >= SAVED_ITEMS || cut.after + cut.size <= SAVED_ITEMS)
            throw new Error('The long turn did not put the cache limit inside the artifacts turn');
        const latest = `agent-chat-turn-${snapshot.items.at(-1)?.turnId ?? ''}`;

        await fixture.pair();
        await tapMobileCheck(serial, row);
        await waitForCheck(serial, latest);
        await waitForNoCheck(serial, 'conversation-jump-latest');
        await revealEarlierTurn(serial);
        await waitForCheck(serial, card);
        await capture(environment, 'live', artifacts);
        await tapMobileCheck(serial, 'session-detail-back');
        await waitForCheck(serial, row);
        await new Promise((resolve) => setTimeout(resolve, READ_CACHE_SETTLE_MS));

        // Online reopen: the saved copy shows first and the live read replaces it.
        recording = environment.remoteVideoPath
            ? await startMobileFramebufferRecording(serial, environment.remoteVideoPath)
            : undefined;
        await coldStart(serial);
        await waitForCheck(serial, row, 60_000);
        await tapMobileCheck(serial, row);
        await waitForCheck(serial, latest, 60_000);
        await new Promise((resolve) => setTimeout(resolve, LIVE_SETTLE_MS));
        await recording?.stop();
        recording = undefined;
        const reopened = await mobileSemantics(serial);
        if (hasCheck(reopened, 'conversation-jump-latest'))
            throw new Error('The reopened Chat left its end');
        await revealEarlierTurn(serial);
        await waitForCheck(serial, card);
        await capture(environment, 'reopened', artifacts);
        await tapMobileCheck(serial, 'session-detail-back');
        await waitForCheck(serial, row);
        await new Promise((resolve) => setTimeout(resolve, READ_CACHE_SETTLE_MS));

        // Offline: the saved copy leaves out the turn its limit would split rather than showing it without cards.
        await setMobileNetworkAvailable(serial, false);
        isNetworkDisabled = true;
        await coldStart(serial);
        await waitForCheck(serial, row, 60_000);
        await tapMobileCheck(serial, row);
        await waitForCheck(serial, 'agent-chat-saved', 60_000);
        await revealEarlierTurn(serial);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const saved = await mobileSemantics(serial);
        const savedTurnRows = saved.filter(({ checkId }) =>
            /^agent-chat-turn-(?!changes-)[^:]+$/u.test(checkId),
        ).length;
        await capture(environment, 'saved', artifacts);
        const hasSplitTurn = hasCheck(saved, `agent-chat-turn-${turnId}`) || hasCheck(saved, card);
        if (hasSplitTurn) throw new Error('The saved copy kept a split turn');
        if (savedTurnRows === 0) throw new Error('The saved copy shows no whole turn');

        await finish(environment, artifacts, {
            fixture: {
                itemsAfterSplitTurn: cut.after,
                savedItemLimit: SAVED_ITEMS,
                splitTurnItems: cut.size,
                totalItems: snapshot.items.length,
            },
            observed: {
                reopenedJumpLatestShown: false,
                savedSplitTurnShown: hasSplitTurn,
                savedTurnRowsVisible: savedTurnRows,
            },
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        if (isNetworkDisabled) {
            try {
                await setMobileNetworkAvailable(serial, true);
            } catch {
                // Teardown must still stop the fixture; the scenario's own failure is the useful error.
            }
        }
        await fixture.stop();
    }
}
