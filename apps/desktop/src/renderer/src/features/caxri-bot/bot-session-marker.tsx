import { HandHelping } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useBotSessionMarker } from './hooks/use-bot-session-marker';

/**
 * The Workbench Session row's sign that Caxri Bot manages the Session: the same hand Caxri Bot's board and its Hand
 * Over button use. For a handed-over Agent conversation the label also warns what takes the Session back (typing into a
 * PTY Agent, sending or stopping in a Chat), which otherwise happens silently. Its own component, so a hand-over
 * re-renders this glyph rather than the whole row.
 */
export function BotSessionMarker({
    className,
    sessionId,
}: {
    className?: string;
    sessionId: string;
}) {
    const { t } = useTranslation();
    const marker = useBotSessionMarker(sessionId);
    if (marker === 'none') return null;
    const label = t(`caxriBot.sessionMarker.${marker}`);
    return (
        <Tooltip content={label}>
            <span
                role="img"
                aria-label={label}
                className={cn(
                    'bot-session-marker flex size-3.5 flex-none items-center justify-center text-muted',
                    className,
                )}
                data-bot-marker={marker}
            >
                <HandHelping aria-hidden="true" size={12} />
            </span>
        </Tooltip>
    );
}
