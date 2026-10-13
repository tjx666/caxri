import { z } from 'zod';

import { editorNavigationTargetSchema } from '../domain/editor.js';
import { identifierSchema, pathSchema } from '../domain/identifiers.js';

export const desktopStatusResultSchema = z.discriminatedUnion('state', [
    z.object({ state: z.literal('offline') }),
    z.object({
        state: z.enum(['background', 'window']),
        generation: z.number().int().positive(),
    }),
]);

export const desktopTargetResultSchema = z.object({
    generation: z.number().int().positive(),
    projectId: identifierSchema,
    sessionId: identifierSchema,
});

export const desktopRootIdentitySchema = z.object({
    path: pathSchema,
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/),
});

export const desktopOpenIdentitySchema = z.object({
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/),
    root: desktopRootIdentitySchema,
});

export const desktopOpenParametersSchema = z.object({
    path: pathSchema,
    sessionId: identifierSchema.optional(),
    expectedIdentity: desktopOpenIdentitySchema.optional(),
    location: editorNavigationTargetSchema.optional(),
    launchIfNeeded: z.boolean().default(true),
});

const hostDesktopRead = {
    owner: 'server',
    effect: 'read',
    requiredCapabilities: ['desktop.window'],
    idempotency: 'none',
} as const;
const hostDesktopControl = {
    owner: 'server',
    effect: 'control',
    requiredCapabilities: ['desktop.window'],
    idempotency: 'request',
} as const;
const noParameters = z.object({}).default({});

/**
 * Server-owned commands that route only bounded native-window operations to the current Desktop.
 */
export const desktopHostMethods = {
    /**
     * Opens only the stored Project root, including Projects without a Session.
     */
    'project.openRoot': {
        ...hostDesktopControl,
        params: z.object({
            projectId: identifierSchema,
            application: z.enum(['finder', 'editor']),
        }),
        result: z.object({
            state: z.enum(['opened', 'revealed']),
            generation: z.number().int().positive(),
            projectId: identifierSchema,
        }),
    },
    'desktop.status': {
        ...hostDesktopRead,
        params: noParameters,
        result: desktopStatusResultSchema,
    },
    'desktop.focus': {
        ...hostDesktopControl,
        params: z.object({ launchIfNeeded: z.boolean().default(false) }).default({
            launchIfNeeded: false,
        }),
        result: z.object({ state: z.literal('focused'), generation: z.number().int().positive() }),
    },
    'desktop.openPath': {
        ...hostDesktopControl,
        params: desktopOpenParametersSchema,
        /**
         * Main has redeemed and dispatched the target; Renderer editor work completes asynchronously.
         */
        result: desktopTargetResultSchema.extend({ state: z.literal('requested') }),
    },
    'desktop.openProject': {
        ...hostDesktopControl,
        params: desktopOpenParametersSchema,
        result: desktopTargetResultSchema.extend({ state: z.literal('requested') }),
    },
    'desktop.openFile': {
        ...hostDesktopControl,
        /**
         * `focusEditor` carries the caller's intent, because this one method serves requests that mean very different
         * things. Picking a file in the file picker or clicking a path link in a Terminal is "I want to read and edit
         * this now", so the keyboard belongs in the editor; `caxri open <path>` from a shell is not, and stealing the
         * keyboard there would interrupt whatever the window was already doing. It is not window focus: that is
         * `desktop.focus`.
         */
        params: desktopOpenParametersSchema.extend({ focusEditor: z.boolean().default(false) }),
        result: desktopTargetResultSchema.extend({ state: z.literal('requested') }),
    },
    'files.reveal': {
        ...hostDesktopControl,
        params: desktopOpenParametersSchema.extend({ launchIfNeeded: z.boolean().default(false) }),
        result: desktopTargetResultSchema.extend({ state: z.literal('revealed') }),
    },
    /**
     * Hands one authorized Project file to the operating system's default application for its type, so an `.html`
     * document opens in the browser. Main performs the launch; the Renderer never resolves an application or spawns a
     * process. Unlike `external.open`, which takes a URL, this takes a path that Server Core re-validates against the
     * Session's authorized Project root before Main sees it.
     */
    'files.openWithDefaultApp': {
        ...hostDesktopControl,
        params: desktopOpenParametersSchema.extend({ launchIfNeeded: z.boolean().default(false) }),
        result: desktopTargetResultSchema.extend({ state: z.literal('opened') }),
    },
    /**
     * Opens an authorized Project root in the operator's configured external editor (`workbench.externalEditor`); the
     * editor process is launched by Main, never by the Renderer.
     */
    'project.openInEditor': {
        ...hostDesktopControl,
        params: desktopOpenParametersSchema.extend({ launchIfNeeded: z.boolean().default(false) }),
        result: desktopTargetResultSchema.extend({ state: z.literal('opened') }),
    },
} as const;
