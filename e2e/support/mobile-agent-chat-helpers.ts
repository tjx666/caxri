import type { AgentChatSnapshot } from '@caxri/protocol';

import { isAndroidCheckId } from '../../scripts/mobile-acceptance-check-id.ts';
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

/**
 * Android semantics drop a `testID` that `isAndroidCheckId` rejects (an uppercase letter, for one), so waiting for it
 * would time out with no hint and waiting for its absence would pass at once. Every check lookup refuses such an id up
 * front.
 */
function requireCheckId(id: string): void {
    if (!isAndroidCheckId(id))
        throw new Error(`Android semantics never expose check id ${id}; use lowercase kebab-case`);
}

/**
 * Whether the semantics include `id`. The one lookup every Android scenario shares, so an id the device can never
 * expose fails at once instead of making a wait time out.
 */
export const hasCheck = (nodes: ReadonlyArray<{ checkId: string }>, id: string): boolean => {
    requireCheckId(id);
    return nodes.some(({ checkId }) => checkId === id);
};

export const waitForCheck = (serial: string, id: string, timeoutMs = 30_000) => {
    requireCheckId(id);
    return waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => hasCheck(nodes, id),
        timeoutMs,
        `check ${id}`,
    );
};

export const waitForNoCheck = (serial: string, id: string, timeoutMs = 30_000) => {
    requireCheckId(id);
    return waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => !hasCheck(nodes, id),
        timeoutMs,
        `check ${id} to disappear`,
    );
};

/**
 * Whether the phone's semantics satisfy `isDone` within `timeoutMs`. A baseline round on the previous build never
 * reaches some states, so a scenario records the outcome and keeps capturing instead of failing at the first
 * difference.
 */
export async function isReachedWithin(
    serial: string,
    isDone: (nodes: readonly MobileSemanticNode[]) => boolean,
    timeoutMs: number,
): Promise<boolean> {
    try {
        await waitForMobile(() => mobileSemantics(serial), isDone, timeoutMs);
        return true;
    } catch {
        return false;
    }
}

export const agentText = (snapshot: AgentChatSnapshot): string =>
    snapshot.items
        .filter((item) => item.type === 'agentMessage')
        .map((item) => item.text)
        .join('\n');

/**
 * Focuses the Chat composer and waits for the expanded capsule's actions row (`+`, settings, send), so the step that
 * follows works on the settled two-row layout. Every provider's Chat has this row, unlike a settings chip such as the
 * model button. `typeRightAfterFocus` covers typing before the row settles.
 */
async function focusChatComposer(serial: string): Promise<void> {
    await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
    await waitForCheck(serial, 'agent-chat-composer-actions');
}

/**
 * Sends one keyword message from the phone. The fake app-server picks its behavior from the keyword, and a single ASCII
 * word survives `input text` without the fixture IME.
 */
export async function sendFromPhone(serial: string, word: string): Promise<void> {
    // `input text` splits on whitespace, so a two-word keyword fails later as an unexplained draft mismatch.
    if (!/^\S+$/u.test(word))
        throw new Error(`sendFromPhone takes one word, got ${JSON.stringify(word)}`);
    await focusChatComposer(serial);
    await adbShell(serial, ['input', 'text', word]);
    const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
        kind: 'equals',
        value: word,
    });
    if (!draft.exists || !draft.textMatches) throw new Error('Chat draft did not match');
    await tapMobileCheck(serial, 'agent-chat-composer-send');
}

/**
 * Taps the collapsed Chat composer and types `word` in the same device shell command, so the word lands while the
 * capsule is still expanding, and then waits for the expanded actions row. Its `entering` fade once stayed at opacity 0
 * in exactly this order: the capsule kept its two-row height, and `+`, settings, and send stayed invisible (#3894).
 */
export async function typeRightAfterFocus(serial: string, word: string): Promise<void> {
    if (!/^[a-z]+$/u.test(word))
        throw new Error(`typeRightAfterFocus takes one lowercase word, got ${word}`);
    const input = checkBounds(await mobileSemantics(serial), 'agent-chat-composer-input');
    if (!input) throw new Error('The Chat composer input is unavailable');
    const x = Math.floor((input.left + input.right) / 2);
    const y = Math.floor((input.top + input.bottom) / 2);
    await adbShell(serial, ['sh', '-c', `'input tap ${x} ${y}; input text ${word}'`]);
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) =>
            hasCheck(nodes, 'agent-chat-composer-actions') &&
            hasCheck(nodes, 'agent-chat-composer-send'),
        10_000,
    );
    const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
        kind: 'equals',
        value: word,
    });
    if (!draft.exists || !draft.textMatches) throw new Error('Chat draft did not match');
}

/**
 * Types `text` into the Chat composer as one draft. `input text` reads `%s` as a space; the text holds only letters,
 * spaces, commas, and periods, so the device shell passes it unchanged.
 */
export async function typeChatDraft(serial: string, text: string): Promise<void> {
    await focusChatComposer(serial);
    await adbShell(serial, ['input', 'text', text.replaceAll(' ', '%s')]);
    const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
        kind: 'equals',
        value: text,
    });
    if (!draft.exists || !draft.textMatches) throw new Error('Chat draft did not match');
}

/**
 * Focuses the Chat composer so its capsule expands to two rows, then waits for `check`, one of the settings chips only
 * the expanded capsule shows (`agent-chat-model-button`, `agent-chat-permission-plan`, `agent-chat-usage-button`).
 */
export async function expandChatComposer(
    serial: string,
    check: string,
    timeoutMs?: number,
): Promise<void> {
    await focusChatComposer(serial);
    await waitForCheck(serial, check, timeoutMs);
}

/**
 * Opens the Chat composer's add sheet and waits for its `entry` row (`agent-chat-add-model`, `-permission`, `-usage`).
 * The add sheet is the settings route that works in both composer layouts: the settings chips show only while the
 * capsule is expanded.
 */
export async function openChatAddSheet(
    serial: string,
    entry: 'model' | 'permission' | 'usage',
): Promise<MobileSemanticNode> {
    const row = `agent-chat-add-${entry}`;
    await tapMobileCheckByBounds(serial, 'agent-chat-attach-image');
    const nodes = await waitForMobile(
        () => mobileSemantics(serial),
        (current) => hasCheck(current, row),
    );
    const node = nodes.find(({ checkId }) => checkId === row);
    if (!node) throw new Error(`The add sheet has no ${row} row`);
    return node;
}

/**
 * Opens one of the Chat's settings sheets through the composer's add sheet, waiting until its row is enabled (the
 * provider has listed its models, or the connection is back).
 */
export async function openChatSetting(
    serial: string,
    entry: 'model' | 'permission' | 'usage',
    timeoutMs = 30_000,
): Promise<void> {
    const row = `agent-chat-add-${entry}`;
    await openChatAddSheet(serial, entry);
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => nodes.some(({ checkId, enabled }) => checkId === row && enabled),
        timeoutMs,
    );
    await tapMobileCheck(serial, row);
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
 * Whether `inner` lies wholly inside `outer`, so nothing of it is clipped by or spills past the edge of `outer`.
 */
export function isInside(inner: ScreenBounds, outer: ScreenBounds): boolean {
    return (
        inner.left >= outer.left &&
        inner.right <= outer.right &&
        inner.top >= outer.top &&
        inner.bottom <= outer.bottom
    );
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

/**
 * Drags the Chat timeline toward earlier messages until `isShown` holds, for content a long reply has scrolled above
 * the screen.
 */
export const scrollTimelineUntil = (serial: string, isShown: () => Promise<boolean>) =>
    waitForMobile(
        async () => {
            const shown = await isShown();
            if (!shown)
                await adbShell(serial, ['input', 'swipe', '540', '700', '540', '1500', '200']);
            return shown;
        },
        (shown) => shown,
    );

/**
 * Drags the Chat timeline toward earlier messages until check `id` is on screen.
 */
export const scrollTimelineTo = (serial: string, id: string) =>
    scrollTimelineUntil(
        serial,
        async () => checkBounds(await mobileSemantics(serial), id) !== undefined,
    );
