import { Flame, KeyRound } from 'lucide-react';

import { useClockTick } from '../../hooks/use-clock-tick';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useSessionSignal } from './hooks/use-session-signal';
import { sessionSignalPresentation } from './session-signal';

/**
 * The row's live signal glyphs, beside the status slot and collapsed with it on row hover; the hover card restates them
 * in words. A Keychain dialog the Session raised shows a key in the row's own foreground (a decision waiting on the
 * user, not a degradation); a Session that has held at least one core for a minute shows a muted flame. Neither
 * notifies: they only answer "which Session is it?" when the user goes looking. Its own component, so a signal change
 * re-renders this glyph rather than the whole row.
 */
export function SessionSignalMarkers({
    className,
    sessionId,
}: {
    className?: string;
    sessionId: string;
}) {
    const { t } = useTranslation();
    const signal = useSessionSignal(sessionId);
    if (!signal?.heat && !signal?.keychainPrompt) return null;
    // The glyphs carry only the short labels, so the time the episode started does not matter here.
    const { heat, keychain } = sessionSignalPresentation(signal, 0, t);
    return (
        <span className={cn('session-signal-markers flex flex-none items-center gap-1', className)}>
            {keychain && (
                <span
                    role="img"
                    aria-label={keychain.label}
                    className="flex size-3.5 items-center justify-center text-foreground"
                    data-session-signal="keychain"
                >
                    <KeyRound aria-hidden="true" size={12} />
                </span>
            )}
            {heat && (
                <span
                    role="img"
                    aria-label={heat.label}
                    className="flex size-3.5 items-center justify-center text-muted"
                    data-session-signal="heat"
                >
                    <Flame aria-hidden="true" size={12} />
                </span>
            )}
        </span>
    );
}

/**
 * The hover card's lines for the same signals: the command asking for Keychain access, and how long the Session has run
 * hot. Mounted only while the card is open, so the minute clock runs only then.
 */
export function SessionCardSignals({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const signal = useSessionSignal(sessionId);
    const now = useClockTick('minute', signal !== undefined);
    const { heat, keychain } = sessionSignalPresentation(signal, now, t);
    return (
        <>
            {keychain && (
                <p
                    className="session-card-keychain mt-1 mb-0 flex min-w-0 items-start gap-1.5 text-[12px] text-foreground"
                    data-session-signal="keychain"
                >
                    <KeyRound aria-hidden="true" className="mt-0.5 flex-none" size={12} />
                    <span className="line-clamp-3 min-w-0 break-all">{keychain.sentence}</span>
                </p>
            )}
            {heat && (
                <p
                    className="session-card-heat mt-1 mb-0 flex min-w-0 items-center gap-1.5 text-[12px] text-muted tabular-nums"
                    data-session-signal="heat"
                >
                    <Flame aria-hidden="true" className="flex-none" size={12} />
                    <span className="min-w-0 truncate">{heat.sentence}</span>
                </p>
            )}
        </>
    );
}

/**
 * The same sentences as plain text for the row's accessible description.
 */
export function SessionSignalDescription({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const signal = useSessionSignal(sessionId);
    const now = useClockTick('minute', signal !== undefined);
    const { heat, keychain } = sessionSignalPresentation(signal, now, t);
    const sentences = [keychain, heat].flatMap((line) =>
        line ? [t('primarySidebar.card.sentence', { text: line.sentence })] : [],
    );
    return sentences.length > 0 ? ` ${sentences.join(' ')}` : null;
}
