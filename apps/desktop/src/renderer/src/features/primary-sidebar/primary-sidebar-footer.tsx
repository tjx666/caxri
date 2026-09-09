import { Archive } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { setArchivedSessionsOpen } from '../../stores/dialogs';

export function PrimarySidebarFooter({ archivedCount }: { archivedCount: number }) {
    return (
        <div className="shrink-0 border-t border-border p-2">
            <Button
                className="archived-sessions-entry w-full justify-start text-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                variant="ghost"
                aria-label={`Archived Sessions (${archivedCount})`}
                onClick={() => setArchivedSessionsOpen(true)}
            >
                <Archive aria-hidden="true" size={14} className="shrink-0" />
                <span className="min-w-0 truncate">Archived Sessions</span>
                <span aria-hidden="true" className="ml-auto text-[11px] tabular-nums">
                    {archivedCount}
                </span>
            </Button>
        </div>
    );
}
