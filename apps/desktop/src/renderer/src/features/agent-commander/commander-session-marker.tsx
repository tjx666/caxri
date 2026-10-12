import { HandHelping } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { useCommanderSessionMarker } from './hooks/use-commander-session-marker';

/**
 * The Workbench Session row's sign that the Agent Commander manages the Session: the same hand the Commander board and
 * its Hand Over button use. For a handed-over Agent conversation the label also warns that typing into it takes the
 * Session back, which otherwise happens silently on the first keystroke. Its own component, so a hand-over re-renders
 * this glyph rather than the whole row.
 */
export function CommanderSessionMarker({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const marker = useCommanderSessionMarker(sessionId);
    if (marker === 'none') return null;
    const label = t(
        marker === 'inputTakesBack'
            ? 'agentCommander.sessionMarker.inputTakesBack'
            : 'agentCommander.sessionMarker.managed',
    );
    return (
        <Tooltip content={label}>
            <span
                role="img"
                aria-label={label}
                className="commander-session-marker flex size-3.5 flex-none items-center justify-center text-muted"
                data-commander-marker={marker}
            >
                <HandHelping aria-hidden="true" size={12} />
            </span>
        </Tooltip>
    );
}
