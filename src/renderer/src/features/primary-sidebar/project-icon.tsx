import type { ProjectIcon as ProjectIconValue } from '@shared/project-customization';
import { FolderClosed, FolderOpen } from 'lucide-react';

import { cn } from '../../lib/utilities';
import { projectIconColorPresentation, projectIconRegistry } from './project-icon-registry';

export function ProjectIcon({
    className,
    expanded = false,
    icon,
    size = 15,
}: {
    className?: string;
    expanded?: boolean;
    icon?: ProjectIconValue;
    size?: number;
}) {
    if (!icon) {
        const Folder = expanded ? FolderOpen : FolderClosed;
        return (
            <Folder
                aria-hidden="true"
                className={cn('project-folder-icon', className)}
                data-project-icon="default-folder"
                size={size}
                strokeWidth={1.7}
            />
        );
    }
    const Icon = projectIconRegistry[icon.name].component;
    return (
        <Icon
            aria-hidden="true"
            className={cn(
                'project-custom-icon',
                icon.color && projectIconColorPresentation[icon.color].textClassName,
                className,
            )}
            data-project-color={icon.color ?? 'default'}
            data-project-icon={icon.name}
            size={size}
            strokeWidth={1.7}
        />
    );
}
