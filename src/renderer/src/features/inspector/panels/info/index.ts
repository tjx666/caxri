import { Info } from 'lucide-react';

import type { InspectorPanelDefinition } from '../types';
import { TerminalInfoPanel } from './terminal-info-panel';

export const infoPanel: InspectorPanelDefinition<'info'> = {
    id: 'info',
    title: 'Info',
    icon: Info,
    Component: TerminalInfoPanel,
    commandId: 'inspector.showInfo',
    resetOnSessionChange: false,
};
