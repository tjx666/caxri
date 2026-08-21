import type { ProjectIconColor, ProjectIconName } from '@shared/project-customization';
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

interface ProjectIconDefinition {
    component: LucideIcon;
    label: string;
}

export const projectIconRegistry: Record<ProjectIconName, ProjectIconDefinition> = {
    'code-2': { component: Code2, label: 'Code' },
    'braces': { component: Braces, label: 'Braces' },
    'square-terminal': { component: SquareTerminal, label: 'Terminal' },
    'database': { component: Database, label: 'Database' },
    'globe-2': { component: Globe2, label: 'Web' },
    'package': { component: Package, label: 'Package' },
    'flask-conical': { component: FlaskConical, label: 'Experiment' },
    'rocket': { component: Rocket, label: 'Rocket' },
};

export const projectIconColorPresentation: Record<
    NonNullable<ProjectIconColor>,
    { label: string; swatchClassName: string; textClassName: string }
> = {
    foreground: {
        label: 'Foreground',
        swatchClassName: 'bg-foreground',
        textClassName: 'text-foreground',
    },
    muted: { label: 'Muted', swatchClassName: 'bg-muted', textClassName: 'text-muted' },
    accent: { label: 'Accent', swatchClassName: 'bg-accent', textClassName: 'text-accent' },
    success: { label: 'Success', swatchClassName: 'bg-success', textClassName: 'text-success' },
    warning: { label: 'Warning', swatchClassName: 'bg-warning', textClassName: 'text-warning' },
    danger: { label: 'Danger', swatchClassName: 'bg-danger', textClassName: 'text-danger' },
};
