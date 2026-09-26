import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
    adbShell,
    androidBounds,
    mobileSemantics,
    observeMobileNode,
    waitForMobile,
} from './mobile-android';

const execFileAsync = promisify(execFile);
const sdk = join(homedir(), 'Library', 'Android', 'sdk');
const adb = join(sdk, 'platform-tools/adb');
const fixtureImeReceiver = 'caxri.acceptance.ime/.FixtureInsertReceiver';

export function mobileFixtureImeBroadcastArguments(
    serial: string,
    value: string,
    mode: 'commit' | 'compose' = 'commit',
): string[] {
    if (!/^emulator-\d+$/u.test(serial))
        throw new Error('Fixture Unicode input requires a disposable emulator');
    return [
        '-s',
        serial,
        'shell',
        'am',
        'broadcast',
        '-n',
        fixtureImeReceiver,
        '--es',
        'textBase64',
        Buffer.from(value, 'utf8').toString('base64'),
        ...(mode === 'compose' ? ['--ez', 'compose', 'true'] : []),
    ];
}

/**
 * Focuses the resource-id owned by the React Native TextInput, then verifies native focus. Android 36's deprecated
 * `uiautomator runtest` can abort and still print `OK (1 test)`.
 */
async function focusMobileInput(serial: string, checkId: string): Promise<void> {
    const input = (await mobileSemantics(serial)).find((node) => node.checkId === checkId);
    const bounds = input && androidBounds(input.bounds);
    if (!input || !bounds || !input.enabled)
        throw new Error(`Android Unicode input ${checkId} is unavailable`);
    await adbShell(serial, [
        'input',
        'tap',
        String(Math.floor((bounds.left + bounds.right) / 2)),
        String(Math.floor((bounds.top + bounds.bottom) / 2)),
    ]);
    try {
        await waitForMobile(
            () => observeMobileNode(serial, checkId),
            ({ exists, focused }) => exists && focused,
            5_000,
        );
    } catch {
        throw new Error(`Android Unicode input ${checkId} was not focused`);
    }
}

/**
 * The Android Acceptance runner installs and selects this fixture IME only on an explicit disposable emulator. Native
 * focus and exact draft are verified through the foreground app's accessibility tree.
 *
 * @see https://developer.android.com/reference/android/view/inputmethod/InputConnection#commitText(java.lang.CharSequence,%20int)
 */
export async function insertMobileInputUnicode(
    serial: string,
    checkId: string,
    value: string,
    expectedText: string,
): Promise<void> {
    await focusMobileInput(serial, checkId);
    await adbShell(serial, ['input', 'keyevent', 'KEYCODE_MOVE_END']);
    await broadcastMobileUnicode(serial, value, 'commit');
    const node = await observeMobileNode(serial, checkId, { kind: 'equals', value: expectedText });
    if (!node.exists || !node.textMatches)
        throw new Error(`Android Unicode input ${checkId} did not match the expected draft`);
}

async function broadcastMobileUnicode(
    serial: string,
    value: string,
    mode: 'commit' | 'compose',
): Promise<void> {
    const arguments_ = mobileFixtureImeBroadcastArguments(serial, value, mode);
    let output: string;
    try {
        const result = await execFileAsync(adb, arguments_);
        output = result.stdout;
    } catch {
        throw new Error('Fixture Unicode input broadcast failed');
    }
    const expectedResult = mode === 'compose' ? 'composed' : 'committed';
    if (!/result=-1\b/u.test(output) || !new RegExp(`data="?${expectedResult}"?`, 'u').test(output))
        throw new Error('Fixture Unicode input was not committed');
}

export async function setMobileComposerUnicode(
    serial: string,
    value: string,
    mode: 'commit' | 'compose' = 'commit',
): Promise<void> {
    await focusMobileInput(serial, 'session-composer-input');
    await broadcastMobileUnicode(serial, value, mode);
    await assertMobileComposerDraft(serial, value);
}

export async function assertMobileComposerDraft(serial: string, value: string): Promise<void> {
    const node = await observeMobileNode(serial, 'session-composer-input', {
        kind: 'equals',
        value,
    });
    if (!node.exists || !node.textMatches)
        throw new Error('Android Unicode composer action failed at verify-result: draft-mismatch');
}

export async function assertMobileComposerFocused(serial: string): Promise<void> {
    const node = await observeMobileNode(serial, 'session-composer-input');
    if (!node.exists || !node.focused)
        throw new Error('Android Unicode composer action failed at focus: composer-not-focused');
}

export async function assertMobileUnknownFeedback(serial: string): Promise<void> {
    const node = await observeMobileNode(serial, 'session-composer-feedback', {
        kind: 'includes',
        value: "Couldn't confirm delivery",
    });
    if (!node.exists || !node.textMatches)
        throw new Error('Unknown delivery feedback is unavailable');
}
