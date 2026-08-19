import { ScrollText } from 'lucide-react';

import type { InspectorPanelDefinition } from '../types';
import { LogViewerPanel } from './log-viewer-panel';

export const logsPanel: InspectorPanelDefinition<'logs'> = {
    id: 'logs',
    title: 'Logs',
    icon: ScrollText,
    Component: LogViewerPanel,
    commandId: 'inspector.showLogs',
    /**
     * Logs are process-wide, not Session-scoped, so the accumulated stream survives Session switches.
     */
    resetOnSessionChange: false,
};
