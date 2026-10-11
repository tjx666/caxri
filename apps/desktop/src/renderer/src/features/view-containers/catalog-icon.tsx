import type { ViewContainerIconGlyph, ViewIcon } from '@caxri/protocol';
import { viewContainerIconGlyph } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import {
    Activity,
    Files,
    FlaskConical,
    GitBranch,
    Inbox,
    Info,
    Package,
    ScrollText,
} from 'lucide-react';

/**
 * Components for the shared container glyph names. The id-to-glyph choice lives in `viewContainerIconGlyph`; mobile's
 * `panelIcon` keeps the same name-to-component table over `lucide-react-native`.
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

export function CatalogIcon({ icon }: { icon: ViewIcon }) {
    if (icon.kind === 'resource') return <img alt="" className="size-4" src={icon.dataUrl} />;
    const Icon = glyphIcons[viewContainerIconGlyph(icon)];
    return <Icon size={16} />;
}
