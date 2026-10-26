import { translateMain } from '../locale';

/**
 * Copy for the one-time notice after an upgrade replaced a stale Server and stopped its live Terminals, or `undefined`
 * when no Terminal was affected.
 */
export function serverReplacementNotice(
    stoppedTerminalCount: number,
): { body: string; title: string } | undefined {
    if (stoppedTerminalCount <= 0) return undefined;
    return {
        title: translateMain('desktop.serverReplaced.title'),
        body: translateMain(
            stoppedTerminalCount === 1
                ? 'desktop.serverReplaced.bodyOne'
                : 'desktop.serverReplaced.bodyOther',
            { count: stoppedTerminalCount },
        ),
    };
}

interface ServerReplacementNotifier {
    /**
     * Reads the "System notifications" setting. A failed read counts as enabled: the notice explains lost Terminals, so
     * losing it to an unreadable setting is worse than showing it.
     */
    isEnabled(): Promise<boolean>;
    isSupported(): boolean;
    show(notice: { body: string; title: string }): void;
}

/**
 * Raises the one-time native notice after an upgrade replaced a stale Server, unless the user turned System
 * notifications off in Settings.
 */
export async function announceServerReplacement(
    stoppedTerminalCount: number,
    notifier: ServerReplacementNotifier,
): Promise<void> {
    const notice = serverReplacementNotice(stoppedTerminalCount);
    if (!notice || !notifier.isSupported()) return;
    let isEnabled = true;
    try {
        isEnabled = await notifier.isEnabled();
    } catch {
        // Keep the default: show the notice.
    }
    if (isEnabled) notifier.show(notice);
}
