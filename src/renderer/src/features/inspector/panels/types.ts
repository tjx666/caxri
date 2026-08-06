import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

import type { InspectorMode } from '@shared/types';

/**
 * Ids of the `inspector.showX` commands from the shared command catalog (`src/shared/commands.ts`).
 * Kept as a local literal union rather than importing a catalog-wide `CommandId` type, since the
 * catalog only types command ids as `string`.
 */
type InspectorCommandId =
    'inspector.showFiles' | 'inspector.showGit' | 'inspector.showStatus' | 'inspector.showInfo';

/** One entry in the Inspector's panel registry, covering both the tab bar and the panel content. */
export interface InspectorPanelDefinition {
    id: InspectorMode;
    title: string;
    icon: LucideIcon;
    Component: ComponentType;
    commandId: InspectorCommandId;
    /**
     * When true, the panel is mounted with `key={sessionId}` so it fully remounts whenever the
     * selected Session changes, per AGENTS.md's session-isolation rule ("Key or reset
     * Session-scoped Renderer state when the selected Session changes"). Git and Status keep
     * repository/diff selection and expansion state that must not leak across Sessions. Files and
     * Info already scope their state to the selected Session internally, so they stay mounted.
     */
    resetOnSessionChange: boolean;
}
