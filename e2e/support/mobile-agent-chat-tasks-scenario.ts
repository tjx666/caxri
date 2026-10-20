import type { AgentChatSnapshot, AgentChatTask } from '@caxri/protocol';
import { draculaTheme } from '@caxri/protocol';

import type { MobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture } from './mobile-agent-actions-scenarios';
import { sendFromPhone, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileColorBounds,
    mobileDisplayState,
    observeMobileNode,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

type ScreenBounds = NonNullable<Awaited<ReturnType<typeof mobileColorBounds>>>;

/**
 * Stop's icon and label: the phone's theme (`mobileTheme.danger`) takes Dracula's danger color, and nothing else in the
 * task sheet uses it.
 */
const STOP_COLOR = draculaTheme.colors.danger;

const runningShell = (snapshot: AgentChatSnapshot): AgentChatTask | undefined =>
    (snapshot.tasks ?? []).find((task) => task.kind === 'shell' && task.status === 'running');

export const centerOf = (bounds: ScreenBounds) => ({
    x: Math.floor((bounds.left + bounds.right) / 2),
    y: Math.floor((bounds.top + bounds.bottom) / 2),
});

const isSameBounds = (a: ScreenBounds, b: ScreenBounds): boolean =>
    a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;

/**
 * Waits until Stop is drawn in `region` at the same place on two reads in a row, and returns where. The sheet grows as
 * a running task's output arrives, which moves Stop with it. `isWanted` rejects a Stop the screen showed before.
 */
export const waitForStop = async (
    serial: string,
    region: ScreenBounds,
    isWanted: (stop: ScreenBounds) => boolean = () => true,
): Promise<ScreenBounds> => {
    let previous: ScreenBounds | undefined;
    const stop = await waitForMobile(
        async () => {
            const current = await mobileColorBounds(serial, region, STOP_COLOR);
            const isSettled =
                current !== undefined && previous !== undefined && isSameBounds(current, previous);
            previous = current;
            return isSettled ? current : undefined;
        },
        (candidate) => candidate !== undefined && isWanted(candidate),
        20_000,
    );
    if (!stop) throw new Error('Stop is not drawn');
    return stop;
};

/**
 * The background work half of `MOB-CHAT-16`: the pill, its sheet, a running task's detail, and Stop from the phone.
 *
 * A running task's row and detail redraw their elapsed time every second, so UIAutomator never finds the idle window it
 * needs to read them. While the task runs the scenario finds Stop by its color in the framebuffer instead: the running
 * row carries it, and so does the detail's status line. Once Stop ends the task the sheet holds still again, and
 * semantics confirm that Stop is gone and that the output tail followed the command.
 */
export async function exerciseChatBackgroundWork(
    environment: MobileAgentScenarioEnvironment,
    chat: NonNullable<MobileAcceptanceFixture['agentChat']>,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const display = await mobileDisplayState(serial);
    const screen = display.size.override ?? display.size.physical;
    // The sheet rises from the bottom; the timeline above it shows nothing in the danger color.
    const sheetRegion = {
        bottom: screen.height,
        left: 0,
        right: screen.width,
        top: Math.floor(screen.height * 0.2),
    };

    await sendFromPhone(serial, 'backgroundquiet');
    const started = await waitForMobile(
        () => chat.read(),
        (snapshot) => !snapshot.activeTurnId && runningShell(snapshot) !== undefined,
    );
    const task = runningShell(started);
    if (!task) throw new Error('No background task is running');
    await waitForNoCheck(serial, 'agent-chat-activity');
    await waitForCheck(serial, 'agent-chat-tasks');
    await capture(environment, 'tasks-pill', artifacts);

    await tapMobileCheckByBounds(serial, 'agent-chat-tasks');
    const rowStop = await waitForStop(serial, sheetRegion);
    await capture(environment, 'tasks-sheet', artifacts);

    // The row's own button covers everything left of Stop.
    const row = centerOf(rowStop);
    await adbShell(serial, ['input', 'tap', String(Math.floor(screen.width / 4)), String(row.y)]);
    // The detail draws its own Stop on the status line, away from where the row's sat.
    const detailStop = await waitForStop(
        serial,
        sheetRegion,
        (stop) => Math.abs(centerOf(stop).y - row.y) > 8,
    );
    // `backgroundquiet` prints a line a second and the detail re-reads the tail while the task runs.
    const openedAt = Date.now();
    await waitForMobile(
        () => Promise.resolve(Date.now()),
        (now) => now - openedAt >= 4000,
        10_000,
    );
    await capture(environment, 'task-detail-running', artifacts);

    // Read Stop again: the output that arrived since has grown the sheet.
    const stop = centerOf(
        await waitForStop(serial, sheetRegion, (candidate) => candidate.top <= detailStop.top),
    );
    await adbShell(serial, ['input', 'tap', String(stop.x), String(stop.y)]);
    await waitForMobile(
        () => chat.read(),
        (snapshot) =>
            (snapshot.tasks ?? []).some(
                (candidate) => candidate.id === task.id && candidate.status !== 'running',
            ),
    );
    // Stop shows only while the task runs, so it leaves once the Chat reports the task ended.
    await waitForNoCheck(serial, 'agent-chat-task-stop', 15_000);
    await waitForCheck(serial, 'agent-chat-task-detail');
    const tail = await observeMobileNode(serial, 'agent-chat-task-output-text', {
        kind: 'includes',
        value: 'tick 3',
    });
    if (!tail.exists || tail.textMatches !== true)
        throw new Error('The task output tail did not follow the command');
    await capture(environment, 'task-stopped', artifacts);
}
