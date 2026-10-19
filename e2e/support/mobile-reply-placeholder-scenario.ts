import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { draculaTheme } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { mobileColorBounds, tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * A still dot's color. The runner's reduced motion leaves the dots at half strength, so each one is the phone theme's
 * muted color (`mobileTheme.muted`, Dracula's) halfway over the background. Reply text is antialiased between the
 * foreground and the background, which stays further than the tolerance from this blue-gray.
 */
const DOT_COLOR = `#${[1, 3, 5]
    .map((offset) => {
        const channel = (color: string) => Number.parseInt(color.slice(offset, offset + 2), 16);
        const { background, muted } = draculaTheme.colors;
        return Math.round((channel(muted) + channel(background)) / 2)
            .toString(16)
            .padStart(2, '0');
    })
    .join('')}`;

const DOT_TOLERANCE = 8;

/**
 * Where the reply starts on the 1080x2400 emulator: the timeline's left column, below the Session tabs and above the
 * composer's activity line. The user's message sits on the right, outside it.
 */
const REPLY_REGION = { bottom: 1700, left: 0, right: 360, top: 560 };

const dotBounds = (serial: string) =>
    mobileColorBounds(serial, REPLY_REGION, DOT_COLOR, DOT_TOLERANCE);

/**
 * `MOB-CHAT-23`: while a running Claude turn shows nothing after the user's message (the fake Claude's `think quietly`
 * held by a `hold-reply` file, as hidden reasoning holds it), the phone holds the reply's place with three dots under
 * the message instead of a blank screen; the dots give way to the reply once it streams.
 */
export async function executeMobileReplyPlaceholderScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    const hold = join(fixture.testDirectory, 'hold-reply');
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await writeFile(hold, '');
        await chat.send({ text: 'think quietly' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => snapshot.activeTurnId !== undefined,
        );
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        // A running turn keeps the header and activity spinners turning, so UIAutomator never idles; read the pixels.
        const dots = await waitForMobile(
            () => dotBounds(serial),
            (bounds) => bounds !== undefined,
        );
        if (!dots || dots.right - dots.left > 160 || dots.bottom - dots.top > 40)
            throw new Error('The reply placeholder is not three dots under the message');
        await capture(environment, 'awaiting-reply', artifacts);

        await rm(hold);
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId &&
                snapshot.items.some((item) => item.type === 'agentMessage'),
        );
        await waitForMobile(
            () => dotBounds(serial),
            (bounds) => bounds === undefined,
        );
        await capture(environment, 'reply-arrived', artifacts);
        await finish(environment, artifacts, { placeholder: 'shown-then-replaced' });
    } finally {
        await rm(hold, { force: true });
        await fixture.stop();
    }
}
