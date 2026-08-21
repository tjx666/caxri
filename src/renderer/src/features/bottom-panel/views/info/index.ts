import { Info } from 'lucide-react';

import type { BottomPanelViewDefinition } from '../types';
import { TerminalInfoPanel } from './terminal-info-panel';

export const infoView: BottomPanelViewDefinition<'info'> = {
    id: 'info',
    title: 'Info',
    icon: Info,
    Component: TerminalInfoPanel,
    commandId: 'bottomPanel.showInfo',
};
