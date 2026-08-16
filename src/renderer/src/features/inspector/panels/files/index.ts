import { Files } from 'lucide-react';

import type { InspectorPanelDefinition } from '../types';
import { FileTreePanel } from './file-tree-panel';

export const filesPanel: InspectorPanelDefinition<'files'> = {
    id: 'files',
    title: 'Files',
    icon: Files,
    Component: FileTreePanel,
    commandId: 'inspector.showFiles',
    resetOnSessionChange: false,
};
