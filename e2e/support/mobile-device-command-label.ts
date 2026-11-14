import { basename } from 'node:path';

/**
 * A command or subcommand name: lowercase words a test author typed, never a path, serial, check id, or payload.
 */
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,31}$/u;

const named = (value: string | undefined): string | undefined =>
    value !== undefined && COMMAND_NAME.test(value) ? value : undefined;

/**
 * Names which device command failed, such as `adb shell uiautomator` or `android-device tap`, so a failed mobile
 * Acceptance run says which step broke. A collapsed `driver-failed` once cost two full runs, because the source-mapped
 * stack pointed at unrelated lines. Only command-name tokens pass: arguments, paths, serials, and stderr stay out,
 * since they can carry device or credential data.
 */
export function mobileDeviceCommandLabel(
    executable: string,
    arguments_: readonly string[],
): string {
    const program = basename(executable);
    if (program === 'adb') {
        const rest = arguments_[0] === '-s' ? arguments_.slice(2) : arguments_;
        const subcommand = named(rest[0]);
        if (!subcommand) return 'adb';
        if (subcommand !== 'shell') return `adb ${subcommand}`;
        return ['adb shell', named(rest[1])].filter(Boolean).join(' ');
    }
    if (program === 'bun' && arguments_[0] === 'run' && arguments_[1]) {
        const script = basename(arguments_[1]).replace(/\.ts$/u, '');
        return [named(script) ?? 'script', named(arguments_[2])].filter(Boolean).join(' ');
    }
    return named(program) ?? 'command';
}
