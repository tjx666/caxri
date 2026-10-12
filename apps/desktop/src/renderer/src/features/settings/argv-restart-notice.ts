import type { ArgvConfig } from '@caxri/protocol';

import { translate } from '../../i18n';
import { getSettingsRegistry } from './settings-registry';

/**
 * A boot flag and the Settings row that owns it share one name: the row backing `argv.jsonc`'s `hardwareAcceleration`
 * declares the binding type `hardware-acceleration`. Resolving the row through that convention keeps the restart notice
 * on the exact title the user just read instead of a second hardcoded label list here, so a boot flag added later is
 * named correctly without touching this file. The owning test asserts every boot flag still resolves to a row.
 */
export function settingTitleForArgvKey(key: keyof ArgvConfig): string | undefined {
    const bindingType = key.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    return getSettingsRegistry(translate).rows.find((row) => row.binding.type === bindingType)
        ?.title;
}

/**
 * Settings titles are sentence case ("Hardware acceleration"), so the first letter has to drop to sit inside a
 * sentence. A title opening on an acronym keeps its capitals: a second capital right after the first means the word is
 * not ordinary sentence case. Scripts without letter case (Chinese) pass through unchanged.
 */
function inSentence(title: string): string {
    const second = title.slice(1, 2);
    if (second && second !== second.toLowerCase()) return title;
    return title.slice(0, 1).toLowerCase() + title.slice(1);
}

function joinTitles(titles: string[]): string {
    if (titles.length <= 1) return titles.join('');
    return `${titles.slice(0, -1).join(translate('settings.argvRestart.listSeparator'))}${translate(
        'settings.argvRestart.listFinalSeparator',
    )}${titles.at(-1)}`;
}

/**
 * Opening shared by every restart notice in the active language. The notice is a replaceable status card rather than a
 * stream of events, so the surface that raises it has to be able to recognize and retract its own previous wording.
 */
export function argvRestartNoticePrefix(): string {
    return translate('settings.argvRestart.prefix');
}

/**
 * Notices raised in this window, so one is still recognized for retraction after a language change altered the prefix.
 * Bounded in practice by the handful of flag combinations and languages.
 */
const raisedNotices = new Set<string>();

export function isArgvRestartNotice(message: string): boolean {
    return raisedNotices.has(message) || message.startsWith(argvRestartNoticePrefix());
}

export function rememberArgvRestartNotice(notice: string): void {
    raisedNotices.add(notice);
}

export interface ArgvRestartNoticeInput {
    /**
     * What the running instance actually launched with, as of Settings load. Undefined until `argv.get` resolves.
     */
    baseline: ArgvConfig | undefined;
    /**
     * What `argv.jsonc` holds after the write completed.
     */
    applied: ArgvConfig;
}

/**
 * The user-facing sentence for the boot flags the next launch would pick up, or undefined when nothing is pending.
 *
 * Every flag still differing from the boot baseline is named, not only the one this write touched: the notice is a
 * single replaceable card, so naming just the latest row would silently retract a restart the user still owes for an
 * earlier one. Returning a flag to the value the running instance launched with cancels its own restart and drops it
 * back out of the sentence.
 */
export function argvRestartNotice(input: ArgvRestartNoticeInput): string | undefined {
    const { applied, baseline } = input;
    if (!baseline) return undefined;
    const pending = (Object.keys(applied) as Array<keyof ArgvConfig>).filter(
        (key) => applied[key] !== baseline[key],
    );
    if (pending.length === 0) return undefined;
    const titles = pending
        .map((key) => settingTitleForArgvKey(key))
        .filter((title): title is string => title !== undefined)
        .map((title) => inSentence(title));
    const isOne = pending.length === 1;
    const body =
        titles.length === 0
            ? translate(
                  isOne ? 'settings.argvRestart.unnamedOne' : 'settings.argvRestart.unnamedOther',
              )
            : translate(
                  isOne ? 'settings.argvRestart.namedOne' : 'settings.argvRestart.namedOther',
                  { titles: joinTitles(titles) },
              );
    return `${argvRestartNoticePrefix()}${body}`;
}
