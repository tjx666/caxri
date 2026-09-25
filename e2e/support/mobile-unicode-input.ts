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

export function mobileFixtureImeBroadcastArguments(serial: string, value: string): string[] {
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
    ];
}

/**
 * Focuses the resource-id owned by the React Native TextInput, then verifies native focus. Android 36's deprecated
 * `uiautomator runtest` can abort and still print `OK (1 test)`.
 */
async function focusMobileComposer(serial: string): Promise<void> {
    const input = (await mobileSemantics(serial)).find(
        ({ checkId }) => checkId === 'session-composer-input',
    );
    const bounds = input && androidBounds(input.bounds);
    if (!input || !bounds || !input.enabled)
        throw new Error('Android Unicode composer action failed at focus: composer-unavailable');
    await adbShell(serial, [
        'input',
        'tap',
        String(Math.floor((bounds.left + bounds.right) / 2)),
        String(Math.floor((bounds.top + bounds.bottom) / 2)),
    ]);
    try {
        await waitForMobile(
            () => observeMobileNode(serial, 'session-composer-input'),
            ({ exists, focused }) => exists && focused,
            5_000,
        );
    } catch {
        throw new Error('Android Unicode composer action failed at focus: composer-not-focused');
    }
}

/**
 * The Android Acceptance runner installs and selects this fixture IME only on an explicit disposable emulator. Native
 * focus and exact draft are verified through the foreground app's accessibility tree.
 *
 * @see https://developer.android.com/reference/android/view/inputmethod/InputConnection#commitText(java.lang.CharSequence,%20int)
 */
export async function setMobileComposerUnicode(serial: string, value: string): Promise<void> {
    const arguments_ = mobileFixtureImeBroadcastArguments(serial, value);
    await focusMobileComposer(serial);
    let output: string;
    try {
        const result = await execFileAsync(adb, arguments_);
        output = result.stdout;
    } catch {
        throw new Error('Fixture Unicode input broadcast failed');
    }
    if (!/result=-1\b/u.test(output) || !/data="?committed"?/u.test(output))
        throw new Error('Fixture Unicode input was not committed');
    await assertMobileComposerDraft(serial, value);
}

/**
 * Optional failure-only probe: append one ASCII character, never submit it, and report no text.
 */
async function diagnoseMobileComposerAscii(
    serial: string,
    expectedDraft: string,
): Promise<{ committed: boolean; reactive: boolean }> {
    try {
        const result = await execFileAsync(adb, mobileFixtureImeBroadcastArguments(serial, 'x'));
        if (!/result=-1\b/u.test(result.stdout) || !/data="?committed"?/u.test(result.stdout))
            return { committed: false, reactive: false };
        await assertMobileComposerDraft(serial, `${expectedDraft}x`);
    } catch {
        return { committed: false, reactive: false };
    }
    try {
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(
                    ({ checkId, enabled }) => checkId === 'session-composer-send' && enabled,
                ),
            5_000,
        );
        return { committed: true, reactive: true };
    } catch {
        return { committed: true, reactive: false };
    }
}

/**
 * Failure-only hardware-key probe. It never submits the draft or records its contents.
 */
async function diagnoseMobileComposerHardwareKey(
    serial: string,
    expectedDraft: string,
): Promise<{ committed: boolean; reactive: boolean }> {
    try {
        await execFileAsync(adb, ['-s', serial, 'shell', 'input', 'text', 'x']);
        await assertMobileComposerDraft(serial, `${expectedDraft}x`);
    } catch {
        return { committed: false, reactive: false };
    }
    try {
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(
                    ({ checkId, enabled }) => checkId === 'session-composer-send' && enabled,
                ),
            5_000,
        );
        return { committed: true, reactive: true };
    } catch {
        return { committed: true, reactive: false };
    }
}

export async function diagnoseMobileComposerInput(
    serial: string,
    expectedDraft: string,
): Promise<string> {
    const { committed, reactive } = await diagnoseMobileComposerAscii(serial, expectedDraft);
    let result = `; ascii-committed:${committed}; ascii-reactive:${reactive}`;
    if (committed && !reactive) {
        const hardware = await diagnoseMobileComposerHardwareKey(serial, `${expectedDraft}x`);
        result += `; hardware-committed:${hardware.committed}; hardware-reactive:${hardware.reactive}`;
    }
    return result;
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
