import type { BootstrapState } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { startMobileFramebufferRecording, waitForMobile } from './mobile-android';
import type { AttentionCommand } from './mobile-attention-fixture';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Long enough apart that rings started by per-glyph animations would show clearly different angles.
 */
const TURN_STAGGER_MS = 400;

/**
 * `MOB-CHAT-SESSION-STATUS-01` and `-02`: three Claude Sessions start working at staggered moments and one of them ends
 * its turn while a background shell still runs. The phone's Session list shows the slow dotted ring for that one and a
 * spinner for the two live turns, and both spinners show the same angle. The screen keeps animating, so the case waits
 * on the Desktop records rather than on UIAutomator semantics.
 */
export async function executeMobileSessionStatusScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'attention', serial });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        const { page } = fixture.running;
        if (!fixture.allowedSessionId)
            throw new Error('Session status fixture Session is unavailable');
        await fixture.pair();
        /**
         * `createProjectSession` would add a Project the phone was not granted, so the extra Sessions join the paired
         * one.
         */
        const createAllowedSession = async () =>
            (
                await pageRequest<{ session: { id: string } }>(page, 'session.create', {
                    projectId: fixture.allowedProjectId,
                    defaultAgent: 'claude',
                })
            ).session.id;
        const sessionIds = [
            fixture.allowedSessionId,
            await createAllowedSession(),
            await createAllowedSession(),
        ];
        const bound = await waitForMobile(
            () => pageRequest<BootstrapState>(page, 'app.bootstrap'),
            (state) =>
                // Input reaches the fixture Agent by Terminal id, so its provider session id is not needed here.
                sessionIds.every((id) =>
                    state.terminals.some(
                        (terminal) =>
                            terminal.sessionId === id && terminal.lastProcessState === 'running',
                    ),
                ),
        );
        const terminalIds = sessionIds.map(
            (id) => bound.terminals.find(({ sessionId }) => sessionId === id)!.id,
        );
        const send = (index: number, command: AttentionCommand) =>
            pageRequest(page, 'terminal.input', {
                terminalId: terminalIds[index],
                data: `${command}\r`,
            });
        for (const index of terminalIds.keys()) {
            // eslint-disable-next-line no-await-in-loop -- turns start at staggered moments on purpose.
            await send(index, 'fixture:start');
            // eslint-disable-next-line no-await-in-loop -- see above.
            await pause(TURN_STAGGER_MS);
        }
        await send(2, 'fixture:background');
        await waitForMobile(
            () => pageRequest<BootstrapState>(page, 'app.bootstrap'),
            (state) =>
                sessionIds.every(
                    (id) =>
                        state.sessions.find((session) => session.id === id)?.agentActivityState ===
                        'running',
                ) &&
                state.terminals.find(({ sessionId }) => sessionId === sessionIds[2])
                    ?.agentOperation === 'background',
        );
        recording = environment.remoteVideoPath
            ? await startMobileFramebufferRecording(serial, environment.remoteVideoPath)
            : undefined;
        // The phone reads the dashboard change through its subscription; give it time to render.
        await pause(3_000);
        // Frames apart show the spinners at different moments, each time at one shared angle.
        for (let frame = 1; frame <= 2; frame += 1) {
            // eslint-disable-next-line no-await-in-loop -- each frame is a later moment of the same spin.
            await capture(environment, `session-list-${frame}`, artifacts);
            // eslint-disable-next-line no-await-in-loop -- spaced frames show the spin moving.
            await pause(450);
        }
        await recording?.stop();
        recording = undefined;
        await finish(environment, artifacts, {
            backgroundSessions: 1,
            motion: 'live',
            runningSessions: 2,
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}
