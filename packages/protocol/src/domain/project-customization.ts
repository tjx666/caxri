import { z } from 'zod';

export const projectIconNames = [
    'code-2',
    'braces',
    'square-terminal',
    'database',
    'globe-2',
    'package',
    'flask-conical',
    'rocket',
] as const;

export const projectIconColors = [
    'foreground',
    'muted',
    'accent',
    'success',
    'warning',
    'danger',
] as const;

export const projectIconSchema = z.strictObject({
    name: z.enum(projectIconNames),
    color: z.enum(projectIconColors).optional(),
});

export type ProjectIcon = z.infer<typeof projectIconSchema>;
export type ProjectIconColor = ProjectIcon['color'];
export type ProjectIconName = ProjectIcon['name'];
