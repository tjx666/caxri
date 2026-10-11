import type { ViewContainerIconGlyph } from '@caxri/protocol';
import { viewContainerIconGlyph } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react-native';
import {
    Activity,
    Files,
    FlaskConical,
    GitBranch,
    Inbox,
    Info,
    Package,
    ScrollText,
} from 'lucide-react-native';

import type { Panel } from './use-panels';

/**
 * Desktop's `CatalogIcon` name-to-component table over `lucide-react-native`. The id-to-glyph choice itself is shared
 * through `viewContainerIconGlyph`, so a Project view tab shows the same glyph as its Desktop secondary-sidebar tab.
 */
const glyphIcons = {
    'activity': Activity,
    'files': Files,
    'flask-conical': FlaskConical,
    'git-branch': GitBranch,
    'inbox': Inbox,
    'info': Info,
    'package': Package,
    'scroll-text': ScrollText,
} satisfies Record<ViewContainerIconGlyph, LucideIcon>;

/**
 * The icon of a Project view tab, from the icon its container declares. Unselected tabs show only this icon, so a
 * container the phone cannot draw (an extension image, which the Server does not project, or an unknown id) gets one
 * generic glyph that never matches Status or Files.
 */
export const panelIcon = (icon: Panel['icon']): LucideIcon =>
    glyphIcons[viewContainerIconGlyph(icon)];
