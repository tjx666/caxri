import { HandHelping } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useCommanderSessionMarker } from './hooks/use-commander-session-marker';

/**
 * The Workbench Session row's sign that the Agent Commander manages the Session: the same hand the Commander board and
 * its Hand Over button use. For a handed-over Agent conversation the label also warns what takes the Session back
 * (typing into a PTY Agent, sending or stopping in a Chat), which otherwise happens silently. Its own component, so a
 * hand-over re-renders this glyph rather than the whole row.
 */
export function CommanderSessionMarker({
    className,
    sessionId,
}: {
    className?: string;
    sessionId: string;
}) {
    const { t } = useTranslation();
    const marker = useCommanderSessionMarker(sessionId);
    if (marker === 'none') return null;
    const label = t(`agentCommander.sessionMarker.${marker}`);
    return (
        <Tooltip content={label}>
            <span
                role="img"
                aria-label={label}
                className={cn(
                    'commander-session-marker flex size-3.5 flex-none items-center justify-center text-muted',
                    className,
                )}
                data-commander-marker={marker}
            >
                <HandHelping aria-hidden="true" size={12} />
            </span>
        </Tooltip>
    );
}
