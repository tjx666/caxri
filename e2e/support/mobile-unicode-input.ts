import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sdk = join(homedir(), 'Library', 'Android', 'sdk');
const java = '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin';
const android = join(sdk, 'platforms/android-36/android.jar');
const automator = join(sdk, 'platforms/android-36/uiautomator.jar');
const d8 = join(sdk, 'build-tools/36.0.0/d8');
const adb = join(sdk, 'platform-tools/adb');
const source = join(import.meta.dirname, 'MobileUnicodeInput.java');
const junitStub = join(import.meta.dirname, 'android-junit-stub/junit/framework/TestCase.java');
const remoteJar = '/data/local/tmp/caxri-mobile-unicode-input.jar';

/**
 * Android's `input text` cannot reliably send Chinese. UiAutomator's text action can set a multiline Unicode value
 * without exposing it in a screenshot, semantic receipt, or desktop log.
 *
 * @see https://developer.android.com/reference/androidx/test/uiautomator/UiObject2#setText(java.lang.String)
 */
async function runComposerAutomation(
    serial: string,
    method:
        | 'testSetUnicodeText'
        | 'testAssertDraft'
        | 'testAssertComposerFocused'
        | 'testAssertUnknownFeedback',
    value = '',
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-unicode-'));
    const classes = join(directory, 'classes');
    const classJar = join(directory, 'mobile-unicode-classes.jar');
    const jar = join(directory, 'mobile-unicode-input.jar');
    try {
        await mkdir(classes);
        await execFileAsync(join(java, 'javac'), [
            '-source',
            '8',
            '-target',
            '8',
            '-cp',
            `${android}:${automator}`,
            '-d',
            classes,
            junitStub,
            source,
        ]);
        await execFileAsync(join(java, 'jar'), ['cf', classJar, '-C', classes, 'caxri/acceptance']);
        await execFileAsync(d8, ['--lib', android, '--output', directory, classJar], {
            env: { ...process.env, JAVA_HOME: join(java, '..') },
        });
        await execFileAsync(join(java, 'jar'), ['cf', jar, '-C', directory, 'classes.dex']);
        await execFileAsync(adb, ['-s', serial, 'push', jar, remoteJar]);
        const result = await execFileAsync(adb, [
            '-s',
            serial,
            'shell',
            'uiautomator',
            'runtest',
            remoteJar,
            '-c',
            `caxri.acceptance.MobileUnicodeInput#${method}`,
            '-e',
            'textBase64',
            Buffer.from(value, 'utf8').toString('base64'),
        ]);
        if (!/OK \(1 test\)/u.test(result.stdout)) {
            throw new Error('Android Unicode composer action did not complete');
        }
    } catch {
        throw new Error('Android Unicode composer action failed');
    } finally {
        await Promise.allSettled([
            execFileAsync(adb, ['-s', serial, 'shell', 'rm', '-f', remoteJar]),
            rm(directory, { force: true, recursive: true }),
        ]);
    }
}

export const setMobileComposerUnicode = (serial: string, value: string): Promise<void> =>
    runComposerAutomation(serial, 'testSetUnicodeText', value);

export const assertMobileComposerDraft = (serial: string, value: string): Promise<void> =>
    runComposerAutomation(serial, 'testAssertDraft', value);

export const assertMobileComposerFocused = (serial: string): Promise<void> =>
    runComposerAutomation(serial, 'testAssertComposerFocused');

export const assertMobileUnknownFeedback = (serial: string): Promise<void> =>
    runComposerAutomation(serial, 'testAssertUnknownFeedback');
