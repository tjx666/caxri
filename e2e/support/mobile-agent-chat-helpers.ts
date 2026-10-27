import type { AgentChatSnapshot } from '@caxri/protocol';

import { MOBILE_FIXTURE_IME_ID } from '../../scripts/mobile-acceptance-ime.ts';
import type { MobileSemanticNode } from './mobile-android';
import {
    adbShell,
    androidBounds,
    mobileSemantics,
    observeMobileNode,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

type ScreenBounds = NonNullable<ReturnType<typeof androidBounds>>;

export const hasCheck = (nodes: Array<{ checkId: string }>, id: string): boolean =>
    nodes.some(({ checkId }) => checkId === id);

export const waitForCheck = (serial: string, id: string, timeoutMs = 30_000) =>
    waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => hasCheck(nodes, id),
        timeoutMs,
    );

export const waitForNoCheck = (serial: string, id: string, timeoutMs = 30_000) =>
    waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => !hasCheck(nodes, id),
        timeoutMs,
    );

export const agentText = (snapshot: AgentChatSnapshot): string =>
    snapshot.items
        .filter((item) => item.type === 'agentMessage')
        .map((item) => item.text)
        .join('\n');

/**
 * Sends one keyword message from the phone. The fake app-server picks its behavior from the keyword, and a single ASCII
 * word survives `input text` without the fixture IME.
 */
export async function sendFromPhone(serial: string, word: string): Promise<void> {
    await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
    await adbShell(serial, ['input', 'text', word]);
    const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
        kind: 'equals',
        value: word,
    });
    if (!draft.exists || !draft.textMatches) throw new Error('Chat draft did not match');
    await tapMobileCheck(serial, 'agent-chat-composer-send');
}

/**
 * Types `text` into the Chat composer as one draft. `input text` reads `%s` as a space; the text holds only letters,
 * spaces, commas, and periods, so the device shell passes it unchanged.
 */
export async function typeChatDraft(serial: string, text: string): Promise<void> {
    await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
    await adbShell(serial, ['input', 'text', text.replaceAll(' ', '%s')]);
    const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
        kind: 'equals',
        value: text,
    });
    if (!draft.exists || !draft.textMatches) throw new Error('Chat draft did not match');
}

/**
 * The on-screen bounds of check `id` among `nodes`, or `undefined` while it is not laid out.
 */
export function checkBounds(
    nodes: readonly MobileSemanticNode[],
    id: string,
): ScreenBounds | undefined {
    const node = nodes.find(({ checkId }) => checkId === id);
    return (node && androidBounds(node.bounds)) ?? undefined;
}

/**
 * Closes the soft keyboard when it is open. Back is sent only after the input method reports itself shown, because the
 * same key on a screen without a keyboard leaves the Chat. The Acceptance fixture IME never draws a keyboard
 * (`onEvaluateInputViewShown` is false) yet still reports `mInputShown=true` while a field is focused, and it does not
 * consume Back, so with it selected there is nothing to close and Back would leave the Chat. A real keyboard's report
 * must also hold across several reads: a focused field that unmounts leaves it set for a moment while the keyboard
 * closes.
 */
export async function hideChatKeyboard(serial: string): Promise<void> {
    const inputMethod = await adbShell(serial, [
        'settings',
        'get',
        'secure',
        'default_input_method',
    ]);
    if (inputMethod.trim() === MOBILE_FIXTURE_IME_ID) return;
    const isShown = async () =>
        /\bmInputShown=true\b/u.test(await adbShell(serial, ['dumpsys', 'input_method']));
    let shownReads = 0;
    const settled = await waitForMobile(
        async () => {
            shownReads = (await isShown()) ? shownReads + 1 : 0;
            return shownReads;
        },
        (reads) => reads === 0 || reads >= 3,
        10_000,
    );
    if (settled === 0) return;
    await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
    await waitForMobile(
        () => isShown(),
        (shown) => !shown,
        10_000,
    );
}

/**
 * Runs `step` with the emulator's own keyboard on screen instead of the Acceptance fixture IME, which draws none, so a
 * layout claim about the keyboard taking half the screen is judged with that half taken. `ime list -s` lists only
 * enabled input methods; the fixture is selected again afterwards, and the guarded runner still restores the emulator's
 * default in its cleanup. Without the fixture selected, the keyboard is already a real one.
 */
export async function withVisibleKeyboard(
    serial: string,
    step: () => Promise<void>,
): Promise<void> {
    const current = await adbShell(serial, ['settings', 'get', 'secure', 'default_input_method']);
    if (current.trim() !== MOBILE_FIXTURE_IME_ID) {
        await step();
        await hideChatKeyboard(serial);
        return;
    }
    const keyboard = (await adbShell(serial, ['ime', 'list', '-s']))
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((id) => id !== '' && id !== MOBILE_FIXTURE_IME_ID);
    if (!keyboard) throw new Error('The emulator has no keyboard besides the fixture IME');
    await adbShell(serial, ['ime', 'set', keyboard]);
    try {
        await step();
        await hideChatKeyboard(serial);
    } finally {
        await adbShell(serial, ['ime', 'set', MOBILE_FIXTURE_IME_ID]);
    }
}

/**
 * The Chat timeline's on-screen frame, read once while the screen is still so a gesture during streaming needs no
 * UIAutomator dump.
 */
export async function chatTimelineFrame(serial: string): Promise<ScreenBounds> {
    const frame = checkBounds(await mobileSemantics(serial), 'conversation-view');
    if (!frame) throw new Error('Chat scroll viewport is unavailable');
    return frame;
}

/**
 * Drags the Chat timeline inside `frame` from a quarter down to four fifths down, which moves it toward earlier
 * messages. Both ends stay inside the content area, away from Android's Back gesture edges.
 */
export async function swipeTimelineTowardEarlier(
    serial: string,
    frame: ScreenBounds,
): Promise<void> {
    const x = Math.floor((frame.left + frame.right) / 2);
    const height = frame.bottom - frame.top;
    await adbShell(serial, [
        'input',
        'swipe',
        String(x),
        String(frame.top + Math.floor(height * 0.25)),
        String(x),
        String(frame.top + Math.floor(height * 0.8)),
        '300',
    ]);
}
