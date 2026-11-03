import type { HostIcon, HostSystemIconName } from '@caxri/protocol';

import { cn } from '../../lib/utilities';
import { projectIconColorPresentation } from '../primary-sidebar/project-icon-registry';
import { hostIconRegistry } from './host-icon-registry';

/**
 * A machine's glyph: the chosen icon in its color, else Auto (the detected system's logo), else the generic Server
 * glyph of an SSH Host that never connected.
 */
export function HostGlyph({
    icon,
    size = 12,
    system,
}: {
    icon?: HostIcon;
    size?: number;
    system?: HostSystemIconName;
}) {
    const { glyph } = hostIconRegistry[icon?.name ?? system ?? 'server'];
    const className = cn(
        'flex-none',
        icon?.color && projectIconColorPresentation[icon.color].textClassName,
    );
    if (!('path' in glyph)) {
        const Icon = glyph;
        return <Icon aria-hidden="true" className={className} size={size} />;
    }
    return (
        <svg
            aria-hidden="true"
            className={className}
            fill="currentColor"
            height={size}
            viewBox="0 0 24 24"
            width={size}
        >
            <path d={glyph.path} />
        </svg>
    );
}
