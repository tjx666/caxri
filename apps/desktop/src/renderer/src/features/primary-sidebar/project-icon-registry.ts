import type { ProjectIconColor, ProjectIconName } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import {
    Braces,
    Code2,
    Database,
    FlaskConical,
    Globe2,
    Package,
    Rocket,
    SquareTerminal,
} from 'lucide-react';

import type { TranslationKey } from '../../i18n';

interface ProjectIconDefinition {
    component: LucideIcon;
    labelKey: TranslationKey;
}

export const projectIconRegistry: Record<ProjectIconName, ProjectIconDefinition> = {
    'code-2': { component: Code2, labelKey: 'primarySidebar.projectIcon.icon.code' },
    'braces': { component: Braces, labelKey: 'primarySidebar.projectIcon.icon.braces' },
    'square-terminal': {
        component: SquareTerminal,
        labelKey: 'primarySidebar.projectIcon.icon.terminal',
    },
    'database': { component: Database, labelKey: 'primarySidebar.projectIcon.icon.database' },
    'globe-2': { component: Globe2, labelKey: 'primarySidebar.projectIcon.icon.web' },
    'package': { component: Package, labelKey: 'primarySidebar.projectIcon.icon.package' },
    'flask-conical': {
        component: FlaskConical,
        labelKey: 'primarySidebar.projectIcon.icon.experiment',
    },
    'rocket': { component: Rocket, labelKey: 'primarySidebar.projectIcon.icon.rocket' },
};

export const projectIconColorPresentation: Record<
    NonNullable<ProjectIconColor>,
    { labelKey: TranslationKey; swatchClassName: string; textClassName: string }
> = {
    foreground: {
        labelKey: 'primarySidebar.projectIcon.color.foreground',
        swatchClassName: 'bg-foreground',
        textClassName: 'text-foreground',
    },
    muted: {
        labelKey: 'primarySidebar.projectIcon.color.muted',
        swatchClassName: 'bg-muted',
        textClassName: 'text-muted',
    },
    accent: {
        labelKey: 'primarySidebar.projectIcon.color.accent',
        swatchClassName: 'bg-accent',
        textClassName: 'text-accent',
    },
    success: {
        labelKey: 'primarySidebar.projectIcon.color.success',
        swatchClassName: 'bg-success',
        textClassName: 'text-success',
    },
    warning: {
        labelKey: 'primarySidebar.projectIcon.color.warning',
        swatchClassName: 'bg-warning',
        textClassName: 'text-warning',
    },
    danger: {
        labelKey: 'primarySidebar.projectIcon.color.danger',
        swatchClassName: 'bg-danger',
        textClassName: 'text-danger',
    },
};
