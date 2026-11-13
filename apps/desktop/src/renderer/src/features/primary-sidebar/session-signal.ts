import type { SessionSignal } from '@caxri/protocol';
import { formatCpuPercent } from '@caxri/protocol';

import type { Translate } from '../../i18n';

export interface SessionSignalLine {
    /**
     * The short accessible name of the row's glyph (`High CPU`, `Keychain request`).
     */
    label: string;
    /**
     * The full sentence the hover card and the row's accessible description show.
     */
    sentence: string;
}

export interface SessionSignalPresentation {
    heat?: SessionSignalLine;
    keychain?: SessionSignalLine;
}

/**
 * Whole minutes since `since`, at least one, so a fresh episode reads "for 1 min" rather than "for 0 min".
 */
function elapsedMinutes(since: number, now: number): number {
    return Math.max(1, Math.floor((now - since) / 60_000));
}

/**
 * Words for a Session's live signals: a Keychain dialog it raised (naming the command, so the user knows what they
 * would be allowing) and a sustained CPU episode.
 */
export function sessionSignalPresentation(
    signal: SessionSignal | undefined,
    now: number,
    t: Translate,
): SessionSignalPresentation {
    const presentation: SessionSignalPresentation = {};
    if (signal?.keychainPrompt) {
        const { command } = signal.keychainPrompt;
        presentation.keychain = {
            label: t('primarySidebar.signal.keychain.label'),
            sentence: command
                ? t('primarySidebar.signal.keychain.sentence', { command })
                : t('primarySidebar.signal.keychain.sentenceUnknown'),
        };
    }
    if (signal?.heat) {
        presentation.heat = {
            label: t('primarySidebar.signal.heat.label'),
            sentence: t('primarySidebar.signal.heat.sentence', {
                cpu: formatCpuPercent(signal.heat.cpuPercent),
                minutes: elapsedMinutes(signal.heat.since, now),
            }),
        };
    }
    return presentation;
}
