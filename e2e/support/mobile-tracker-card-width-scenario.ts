import type { AgentChatSnapshot } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    chatTimelineFrame,
    swipeTimelineTowardEarlier,
    waitForCheck,
} from './mobile-agent-chat-helpers';
import { mobileNativeControlBounds, tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * The fake Codex `artifacts` turn opens `acme/widgets#42` and files the Linear issue `ENG-12`, whose card carries the
 * button that starts the issue in a new Session.
 */
const PULL_ROW = 'agent-chat-tracker-acme/widgets#42';
const ISSUE_ROW = 'agent-chat-tracker-ENG-12';
const ISSUE_HANDOFF = 'agent-chat-tracker-handoff-ENG-12';

/**
 * How many drags toward earlier messages the scenario allows before the cards must be on screen.
 */
const MAX_SWIPES = 4;

/**
 * Device pixels two edges of the same layout column may differ by after dp-to-pixel rounding.
 */
const EDGE_TOLERANCE_PX = 2;

const isIdle = (snapshot: AgentChatSnapshot): boolean =>
    !snapshot.activeTurnId && snapshot.turns.every((turn) => turn.status !== 'running');

/**
 * `MOB-CHAT-TRACKER-CARD-01`: a finished turn shows a pull request card and an issue card. The issue card's "start in a
 * new Session" button sits inside the card's border, so the issue card is as wide as its siblings. Before the fix the
 * button sat outside the card and narrowed it, its trailing edge reaching past the pull request card's row (which ends
 * one border inside its card); inside the card it ends at least one border and the card's trailing inset short of it.
 */
export async function executeMobileTrackerCardWidthScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        const chat = fixture.agentChat;
        const sessionId = fixture.allowedSessionId;
        if (!chat || !sessionId) throw new Error('Chat fixture is unavailable');
        await chat.send({ text: 'artifacts' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                isIdle(snapshot) && snapshot.items.some((item) => item.type === 'fileChange'),
        );
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, 'agent-chat');
        /**
         * The tracker testIDs carry `#` and uppercase keys, which the semantic check-id helper does not expose, so the
         * rows are read by their exact Android resource id instead.
         */
        const find = (resourceId: string) => mobileNativeControlBounds(serial, { resourceId });
        const readRows = async () => ({
            handoff: await find(ISSUE_HANDOFF),
            issue: await find(ISSUE_ROW),
            pull: await find(PULL_ROW),
        });
        let rows = await readRows();
        for (
            let swipe = 0;
            swipe < MAX_SWIPES && !(rows.pull && rows.issue && rows.handoff);
            swipe++
        ) {
            // eslint-disable-next-line no-await-in-loop -- each drag must settle before the next read
            await swipeTimelineTowardEarlier(serial, await chatTimelineFrame(serial));
            // eslint-disable-next-line no-await-in-loop -- read after the drag above
            rows = await readRows();
        }
        const { handoff, issue, pull } = rows;
        if (!pull || !issue || !handoff) throw new Error('The tracker cards are not on screen');
        await capture(environment, 'tracker-cards', artifacts);
        if (Math.abs(issue.left - pull.left) > EDGE_TOLERANCE_PX)
            throw new Error('The issue card is offset from its siblings');
        const observed = {
            handoffRight: handoff.right,
            issueLeft: issue.left,
            pullLeft: pull.left,
            pullRight: pull.right,
        };
        if (handoff.right >= pull.right) {
            throw new Error(
                `The issue card's handoff button sits outside the card (${JSON.stringify(observed)})`,
            );
        }
        await finish(environment, artifacts, { observed, status: 'passed' });
    } finally {
        await fixture.stop();
    }
}
