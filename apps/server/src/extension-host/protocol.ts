import { Buffer } from 'node:buffer';

import type {
    ExtensionViewChange,
    ExtensionViewEventContext,
    ExtensionViewOperationName,
    ProjectStatusSummary,
} from '@caxri/protocol';
import {
    extensionCapabilitySchema,
    extensionCommandIdSchema,
    extensionIdSchema,
    extensionManifestSchema,
    extensionViewEventContextSchema,
    extensionViewOperationNameSchema,
    MAX_EXTENSION_COMMAND_ARGUMENTS,
    MAX_VIEW_CATALOG_EXTENSIONS,
    viewIdSchema,
} from '@caxri/protocol';
import type { ObservationContext } from '@caxri/system';
import { z } from 'zod';

import { observationContextSchema } from '../observability/context-schema';

export type ExtensionProjectStatusSummary = Omit<ProjectStatusSummary, 'repositories'> & {
    repositories: Array<Omit<ProjectStatusSummary['repositories'][number], 'rootPath'>>;
};

export const MAX_EXTENSION_PROJECT_STATUS_REFRESH_TOKEN_LENGTH = 200;

export const extensionWorkspaceOperations = [
    'git.summary',
    'git.sync',
    'git.discard',
    'git.mergePullRequest',
    'git.pullRequestChanges',
    'git.commits',
    'git.commitDetails',
    'git.remoteHost',
] as const;

export type ExtensionWorkspaceOperation = (typeof extensionWorkspaceOperations)[number];

export type ExtensionViewOperation = ExtensionViewOperationName;

const privateIdentifierSchema = z.string().min(1).max(200);
const privatePathSchema = z.string().min(1).max(16_384);
const generationSchema = z.number().int().nonnegative();
const activationReasonSchema = z.string().min(1).max(200);
const parentHandleSchema = z.string().min(1).max(512);
const optionalParentHandleSchema = parentHandleSchema.optional();
const optionalObservationContextSchema = observationContextSchema.optional();
const optionalExtensionViewEventContextSchema = extensionViewEventContextSchema.optional();
const extensionHostErrorSchema = z
    .object({
        code: z.string().min(1).max(100),
        message: z.string().min(1).max(2_048),
    })
    .strict();

function hasBoundedJson(value: unknown, maximumBytes: number): boolean {
    try {
        const serialized = JSON.stringify([value]);
        return Buffer.byteLength(serialized, 'utf8') <= maximumBytes;
    } catch {
        return false;
    }
}

const commandArgumentsSchema = z
    .array(z.unknown())
    .max(MAX_EXTENSION_COMMAND_ARGUMENTS)
    .refine((value) => hasBoundedJson(value, 64 * 1_024), 'Command arguments exceed IPC bounds');
const viewArgumentsSchema = z
    .unknown()
    .refine(
        (value) => hasBoundedJson(value, 4 * 1_024 * 1_024),
        'View arguments exceed IPC bounds',
    );
const apiReplyResultSchema = z
    .unknown()
    .refine((value) => hasBoundedJson(value, 4 * 1_024 * 1_024), 'API result exceeds IPC bounds');

const extensionHostRegistrationSchema = z
    .object({
        extensionId: extensionIdSchema,
        generation: generationSchema,
        apiToken: privateIdentifierSchema,
        rootPath: privatePathSchema,
        entryPath: privatePathSchema,
        manifest: extensionManifestSchema,
        grants: z.array(extensionCapabilitySchema).max(32),
        projectIds: z.array(privateIdentifierSchema).max(4_096),
    })
    .strict();
export type ExtensionHostRegistration = z.infer<typeof extensionHostRegistrationSchema>;
const extensionRegistrationsSchema = z
    .array(extensionHostRegistrationSchema)
    .max(MAX_VIEW_CATALOG_EXTENSIONS);

export type ExtensionViewEventScope = ExtensionViewEventContext;

const requestBase = {
    id: privateIdentifierSchema,
    observation: optionalObservationContextSchema,
};
const extensionContextNotificationSchemas = [
    'activeContextChanged',
    'gitChanged',
    'projectStatusChanged',
] as const;
const extensionHostRequestSchema = z.discriminatedUnion('method', [
    z
        .object({
            ...requestBase,
            method: z.literal('configure'),
            params: z
                .object({
                    extensions: extensionRegistrationsSchema,
                })
                .strict(),
        })
        .strict(),
    z
        .object({
            ...requestBase,
            method: z.literal('activate'),
            params: z
                .object({
                    extensionId: extensionIdSchema,
                    generation: generationSchema,
                    reason: activationReasonSchema,
                })
                .strict(),
        })
        .strict(),
    z
        .object({
            ...requestBase,
            method: z.literal('treeChildren'),
            params: z
                .object({
                    extensionId: extensionIdSchema,
                    generation: generationSchema,
                    viewId: viewIdSchema,
                    parentHandle: optionalParentHandleSchema,
                    requestId: privateIdentifierSchema,
                    context: optionalExtensionViewEventContextSchema,
                })
                .strict(),
        })
        .strict(),
    z
        .object({
            ...requestBase,
            method: z.literal('executeCommand'),
            params: z
                .object({
                    extensionId: extensionIdSchema,
                    generation: generationSchema,
                    commandId: extensionCommandIdSchema,
                    arguments: commandArgumentsSchema,
                    context: extensionViewEventContextSchema,
                })
                .strict(),
        })
        .strict(),
    z
        .object({
            ...requestBase,
            method: z.literal('viewOperation'),
            params: z
                .object({
                    extensionId: extensionIdSchema,
                    generation: generationSchema,
                    viewId: viewIdSchema,
                    operation: extensionViewOperationNameSchema,
                    arguments: viewArgumentsSchema,
                    requestId: privateIdentifierSchema,
                    context: extensionViewEventContextSchema,
                })
                .strict(),
        })
        .strict(),
    ...extensionContextNotificationSchemas.map((method) =>
        z
            .object({
                ...requestBase,
                method: z.literal(method),
                params: z.object({ context: extensionViewEventContextSchema }).strict(),
            })
            .strict(),
    ),
    z
        .object({
            ...requestBase,
            method: z.literal('cancel'),
            params: z.object({ requestId: privateIdentifierSchema }).strict(),
        })
        .strict(),
    z
        .object({
            ...requestBase,
            method: z.literal('shutdown'),
            params: z.object({}).strict(),
        })
        .strict(),
]);
export type ExtensionHostRequest = z.infer<typeof extensionHostRequestSchema>;

interface ExtensionHostApiRequestBase {
    type: 'api-request';
    id: string;
    extensionId: string;
    generation: number;
    apiToken: string;
    observation?: ObservationContext;
}

export type ExtensionHostApiRequest = ExtensionHostApiRequestBase &
    (
        | {
              method: 'workspace.getProjectStatus';
              params: { refreshToken?: string; context: ExtensionViewEventScope };
          }
        | {
              method: 'workspace.getConfiguration';
              params: { key: string };
          }
        | {
              method: 'workspace.request';
              params: {
                  operation: ExtensionWorkspaceOperation;
                  arguments: unknown;
                  context: ExtensionViewEventScope;
              };
          }
    );

export type ExtensionHostMessage =
    | ExtensionHostApiRequest
    | { type: 'api-cancel'; id: string }
    | { type: 'ready' }
    | { type: 'reply'; id: string; ok: true; result: unknown }
    | {
          type: 'reply';
          id: string;
          ok: false;
          error: { code: string; message: string };
      }
    | {
          type: 'event';
          event: 'treeChanged';
          extensionId: string;
          generation: number;
          viewId: string;
          eventId: string;
          context: ExtensionViewEventScope;
          handles?: string[];
      }
    | {
          type: 'event';
          event: 'viewChanged';
          extensionId: string;
          generation: number;
          viewId: string;
          eventId: string;
          context: ExtensionViewEventScope;
          change: ExtensionViewChange;
      };

const extensionHostApiReplySchema = z.discriminatedUnion('ok', [
    z
        .object({
            type: z.literal('api-reply'),
            id: privateIdentifierSchema,
            ok: z.literal(true),
            result: apiReplyResultSchema,
        })
        .strict(),
    z
        .object({
            type: z.literal('api-reply'),
            id: privateIdentifierSchema,
            ok: z.literal(false),
            error: extensionHostErrorSchema,
        })
        .strict(),
]);
export const extensionHostParentMessageSchema = z.union([
    extensionHostRequestSchema,
    extensionHostApiReplySchema,
]);
export type ExtensionHostParentMessage = z.infer<typeof extensionHostParentMessageSchema>;
