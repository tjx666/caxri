import type { ExtensionBuiltinIconId, ViewIcon } from '@caxri/protocol';
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

const builtinIcons = {
    'files': Files,
    'git-branch': GitBranch,
    'inbox': Inbox,
    'info': Info,
    'scroll-text': ScrollText,
} as const;

const extensionBuiltinIcons = {
    'beaker': FlaskConical,
    'files': Files,
    'git-branch': GitBranch,
    'status': Activity,
} satisfies Record<ExtensionBuiltinIconId, LucideIcon>;

export function CatalogIcon({ icon }: { icon: ViewIcon }) {
    if (icon.kind === 'resource') return <img alt="" className="size-4" src={icon.dataUrl} />;
    const builtinIconId = icon.kind === 'builtin' ? icon.id : undefined;
    let Icon: LucideIcon = Package;
    if (builtinIconId !== undefined) {
        if (builtinIconId in builtinIcons)
            Icon = builtinIcons[builtinIconId as keyof typeof builtinIcons];
        else if (builtinIconId in extensionBuiltinIcons)
            Icon = extensionBuiltinIcons[builtinIconId as ExtensionBuiltinIconId];
    }
    return <Icon size={16} />;
}
