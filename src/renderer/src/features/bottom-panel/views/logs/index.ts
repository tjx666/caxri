import { Logs } from 'lucide-react';

import type { BottomPanelViewDefinition } from '../types';
import { LogViewerPanel } from './log-viewer-panel';

export const logsView: BottomPanelViewDefinition<'logs'> = {
    id: 'logs',
    title: 'Logs',
    icon: Logs,
    Component: LogViewerPanel,
    commandId: 'bottomPanel.showLogs',
};
