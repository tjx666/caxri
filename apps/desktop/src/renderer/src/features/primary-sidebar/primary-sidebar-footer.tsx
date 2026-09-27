import { Archive } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { setArchivedSessionsOpen } from '../../stores/dialogs';

/**
 * The global Archived Sessions entry. It is deliberately just the archive glyph and the count: the entry is visited
 * rarely, so a full-width text label would spend a permanent row of chrome naming something the tooltip and the
 * accessible name already name.
 */
export function PrimarySidebarFooter({ archivedCount }: { archivedCount: number }) {
    return (
        <div className="flex shrink-0 items-center border-t border-border px-2 py-1">
            <Tooltip content="Archived Sessions">
                <Button
                    className="archived-sessions-entry gap-1.5 text-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                    size="sm"
                    variant="ghost"
                    aria-label={`Archived Sessions (${archivedCount})`}
                    onClick={() => setArchivedSessionsOpen(true)}
                >
                    <Archive aria-hidden="true" size={13} className="shrink-0" />
                    <span aria-hidden="true" className="tabular-nums">
                        {archivedCount}
                    </span>
                </Button>
            </Tooltip>
        </div>
    );
}
