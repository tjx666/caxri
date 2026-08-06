import { Activity } from 'lucide-react';

import type { InspectorPanelDefinition } from '../types';
import { ProjectStatusPanel } from './ProjectStatusPanel';

export const statusPanel: InspectorPanelDefinition = {
    id: 'status',
    title: 'Status',
    icon: Activity,
    Component: ProjectStatusPanel,
    commandId: 'inspector.showStatus',
    resetOnSessionChange: true,
};
