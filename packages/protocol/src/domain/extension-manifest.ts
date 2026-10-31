import { z } from 'zod';

import {
    contributedViewContainerIdSchema,
    controlledViewPresentationSchema,
    extensionBuiltinIconIdSchema,
    extensionCapabilitySchema,
    extensionCommandIdSchema,
    extensionIdSchema,
    extensionViewActionRoleSchema,
    viewContainerIdSchema,
    viewIdSchema,
} from './views.js';

const manifestIconResourcePathSchema = z
    .string()
    .min(1)
    .max(1_024)
    .regex(/^(?:\.\/)?(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+\.(?:png|svg)$/i);

const manifestContainerIconSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('builtin'), id: extensionBuiltinIconIdSchema }),
    z.object({ kind: z.literal('resource'), path: manifestIconResourcePathSchema }),
]);

const manifestContainerSchema = z.object({
    id: contributedViewContainerIdSchema,
    title: z.string().min(1).max(200),
    order: z.number().int().min(0).max(10_000).optional(),
    icon: manifestContainerIconSchema,
    command: extensionCommandIdSchema.optional(),
});

const manifestViewSchema = z.object({
    id: viewIdSchema,
    name: z.string().min(1).max(200),
    type: z.enum(['tree', 'source-control']),
    badge: z.literal(true).optional(),
    presentation: controlledViewPresentationSchema.optional(),
    configurationDependencies: z.array(z.string().min(1).max(200)).max(32).optional(),
    actions: z
        .array(
            z.object({
                command: extensionCommandIdSchema,
                role: extensionViewActionRoleSchema,
            }),
        )
        .max(32)
        .optional(),
    when: z.never().optional(),
});

const manifestCommandSchema = z.object({
    command: extensionCommandIdSchema,
    title: z.string().min(1).max(200),
    description: z.string().max(1_024).optional(),
    allowInEditable: z.boolean().optional(),
    palette: z.boolean().optional(),
});

const manifestViewContainersSchema = z.object({
    secondarySidebar: z.array(manifestContainerSchema).max(64).default([]),
    panel: z.array(manifestContainerSchema).max(64).default([]),
});

const manifestViewsSchema = z.record(viewContainerIdSchema, z.array(manifestViewSchema).max(64));

const manifestContributionsSchema = z.object({
    viewsContainers: manifestViewContainersSchema.default({ secondarySidebar: [], panel: [] }),
    views: manifestViewsSchema.default({}),
    commands: z.array(manifestCommandSchema).max(256).default([]),
});

/**
 * `package.json` contract of a bundled Caxri extension: its entry point, capabilities, and contributed view containers,
 * views, and commands.
 */
export const extensionManifestSchema = z
    .object({
        name: extensionIdSchema,
        version: z.string().min(1).max(100),
        type: z.literal('module'),
        main: z
            .string()
            .min(1)
            .max(1_024)
            .regex(/^(?:\.\/)?(?!.*(?:^|\/)\.\.(?:\/|$)).+\.(?:js|mjs)$/),
        engines: z.object({ caxri: z.string().min(1).max(100) }),
        caxri: z.object({
            capabilities: z.array(extensionCapabilitySchema).max(32).default([]),
            testOnly: z.boolean().optional(),
        }),
        activationEvents: z.never().optional(),
        contributes: manifestContributionsSchema.default({
            viewsContainers: { secondarySidebar: [], panel: [] },
            views: {},
            commands: [],
        }),
    })
    .superRefine((manifest, context) => {
        const commandIds = new Set(manifest.contributes.commands.map(({ command }) => command));
        for (const [containerId, views] of Object.entries(manifest.contributes.views)) {
            for (const [viewIndex, view] of views.entries()) {
                if (
                    (view.configurationDependencies?.length ?? 0) > 0 &&
                    !manifest.caxri.capabilities.includes('settings.read')
                )
                    context.addIssue({
                        code: 'custom',
                        message: 'Controlled view configuration dependencies require settings.read',
                        path: [
                            'contributes',
                            'views',
                            containerId,
                            viewIndex,
                            'configurationDependencies',
                        ],
                    });
                const roles = new Set<string>();
                const actions = view.actions ?? [];
                for (const [actionIndex, action] of actions.entries()) {
                    const path = [
                        'contributes',
                        'views',
                        containerId,
                        viewIndex,
                        'actions',
                        actionIndex,
                    ];
                    if (!commandIds.has(action.command))
                        context.addIssue({
                            code: 'custom',
                            message: `View action command is not declared: ${action.command}`,
                            path: [...path, 'command'],
                        });
                    const requiredPrefix = view.type === 'source-control' ? 'source.' : undefined;
                    const isCompatibleTreeRefresh =
                        view.type === 'tree' && action.role === 'resource.refresh';
                    if (
                        !isCompatibleTreeRefresh &&
                        (!requiredPrefix || !action.role.startsWith(requiredPrefix))
                    )
                        context.addIssue({
                            code: 'custom',
                            message: `View action role is incompatible with ${view.type}: ${action.role}`,
                            path: [...path, 'role'],
                        });
                    if (roles.has(action.role))
                        context.addIssue({
                            code: 'custom',
                            message: `Duplicate view action role: ${action.role}`,
                            path: [...path, 'role'],
                        });
                    roles.add(action.role);
                }
            }
        }
    });

export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;

/**
 * Upper bound on one extension localization file (`package.nls*.json` or `l10n/bundle.l10n.<locale>.json`), the same as
 * the manifest itself.
 */
export const MAX_EXTENSION_L10N_FILE_BYTES = 256 * 1_024;

/**
 * A localization file's contents: VS Code's flat `{ key: message }` shape. Manifest files key by the `%key%`
 * placeholder name; runtime bundles key by the English source message an extension passes to `l10n.t`.
 */
export const extensionL10nBundleSchema = z.record(
    z.string().min(1).max(2_048),
    z.string().min(1).max(2_048),
);

export type ExtensionL10nBundle = z.infer<typeof extensionL10nBundleSchema>;

/**
 * The file-name suffix of a locale's localization files, lower-cased the way VS Code names them: `zh-CN` reads
 * `package.nls.zh-cn.json` and `l10n/bundle.l10n.zh-cn.json`.
 */
export function extensionL10nFileLocale(locale: string): string {
    return locale.toLowerCase();
}
