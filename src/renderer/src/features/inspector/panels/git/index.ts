import { GitBranch } from 'lucide-react';

import type { InspectorPanelDefinition } from '../types';
import { GitPanel } from './git-panel';

export const gitPanel: InspectorPanelDefinition<'git'> = {
    id: 'git',
    title: 'Git',
    icon: GitBranch,
    Component: GitPanel,
    commandId: 'inspector.showGit',
    resetOnSessionChange: true,
};
