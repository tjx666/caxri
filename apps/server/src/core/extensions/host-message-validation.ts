import { Buffer } from 'node:buffer';

import type { CaxriErrorCode } from '@caxri/protocol';
import {
    CaxriError,
    errorCodes,
    extensionViewChangeSchema,
    extensionViewEventContextSchema,
    extensionViewEventIdSchema,
    MAX_VIEW_TREE_ITEMS,
    MAX_VIEW_TREE_PAYLOAD_BYTES,
    treeItemSchema,
} from '@caxri/protocol';

import type { ExtensionHostMessage, ExtensionHostRequest } from '../../extension-host/protocol';
import {
    extensionWorkspaceOperations,
    MAX_EXTENSION_PROJECT_STATUS_REFRESH_TOKEN_LENGTH,
} from '../../extension-host/protocol';
import { observationContextSchema } from '../../observability/context-schema';

/**
 * Validation for every message the Extension Host child sends to Server Core. The child is untrusted extension code, so
 * envelopes and reply payloads are bounded and shape-checked here before the supervisor dispatches them.
 */
const MAX_EXTENSION_API_ARGUMENT_BYTES = 64 * 1_024;
const MAX_EXTENSION_VIEW_RESULT_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isBoundedString(value: unknown, max: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function hasBoundedApiArguments(value: unknown): boolean {
    if (!isRecord(value)) return false;
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_EXTENSION_API_ARGUMENT_BYTES;
    } catch {
        return false;
    }
}

function isViewChange(value: unknown): boolean {
    return extensionViewChangeSchema.safeParse(value).success;
}

function hasBoundedViewResult(value: unknown): boolean {
    if (value === undefined || ['bigint', 'function', 'symbol'].includes(typeof value))
        return false;
    try {
        const serialized = JSON.stringify(value);
        return Buffer.byteLength(serialized, 'utf8') <= MAX_EXTENSION_VIEW_RESULT_BYTES;
    } catch {
        return false;
    }
}

export function extensionHostReplyError(error: { code: string; message: string }): Error {
    if (errorCodes.includes(error.code as CaxriErrorCode))
        return new CaxriError(error.code as CaxriErrorCode, error.message);
    return Object.assign(new Error(error.message), { code: error.code });
}

export function isExtensionHostMessage(value: unknown): value is ExtensionHostMessage {
    if (!isRecord(value) || typeof value.type !== 'string') return false;
    if (value.type === 'ready') return true;
    if (value.type === 'api-request')
        return (
            isBoundedString(value.id, 200) &&
            isBoundedString(value.extensionId, 200) &&
            Number.isSafeInteger(value.generation) &&
            Number(value.generation) >= 0 &&
            isBoundedString(value.apiToken, 200) &&
            (value.observation === undefined ||
                observationContextSchema.safeParse(value.observation).success) &&
            isRecord(value.params) &&
            ((value.method === 'workspace.getProjectStatus' &&
                extensionViewEventContextSchema.safeParse(value.params.context).success &&
                (value.params.refreshToken === undefined ||
                    isBoundedString(
                        value.params.refreshToken,
                        MAX_EXTENSION_PROJECT_STATUS_REFRESH_TOKEN_LENGTH,
                    ))) ||
                (value.method === 'workspace.getConfiguration' &&
                    isBoundedString(value.params.key, 200)) ||
                (value.method === 'workspace.request' &&
                    typeof value.params.operation === 'string' &&
                    extensionWorkspaceOperations.includes(
                        value.params.operation as (typeof extensionWorkspaceOperations)[number],
                    ) &&
                    extensionViewEventContextSchema.safeParse(value.params.context).success &&
                    hasBoundedApiArguments(value.params.arguments)))
        );
    if (value.type === 'api-cancel') return isBoundedString(value.id, 200);
    if (value.type === 'event') {
        const isIdentityIsValid =
            isBoundedString(value.extensionId, 200) &&
            Number.isSafeInteger(value.generation) &&
            Number(value.generation) >= 0 &&
            isBoundedString(value.viewId, 200) &&
            extensionViewEventIdSchema.safeParse(value.eventId).success &&
            extensionViewEventContextSchema.safeParse(value.context).success;
        if (!isIdentityIsValid) return false;
        if (value.event === 'viewChanged') return isViewChange(value.change);
        return (
            value.event === 'treeChanged' &&
            (value.handles === undefined ||
                (Array.isArray(value.handles) &&
                    value.handles.length <= MAX_VIEW_TREE_ITEMS &&
                    value.handles.every((handle) => isBoundedString(handle, 512))))
        );
    }
    if (value.type !== 'reply' || !isBoundedString(value.id, 200) || typeof value.ok !== 'boolean')
        return false;
    return (
        value.ok ||
        (isRecord(value.error) &&
            isBoundedString(value.error.code, 100) &&
            isBoundedString(value.error.message, 2_048))
    );
}

export function isExtensionHostResult(
    method: ExtensionHostRequest['method'],
    value: unknown,
): boolean {
    if (method === 'viewOperation') return hasBoundedViewResult(value);
    if (!isRecord(value)) return false;
    switch (method) {
        case 'configure':
            return Number.isSafeInteger(value.configured) && Number(value.configured) >= 0;
        case 'activate':
            return value.activated === true;
        case 'treeChildren':
            return (
                Array.isArray(value.items) &&
                value.items.length <= MAX_VIEW_TREE_ITEMS &&
                value.items.every((item) => treeItemSchema.safeParse(item).success) &&
                Buffer.byteLength(JSON.stringify(value), 'utf8') <=
                    MAX_VIEW_TREE_PAYLOAD_BYTES + 1_024
            );
        case 'executeCommand':
            return value.executed === true;
        case 'activeContextChanged':
        case 'gitChanged':
        case 'languageChanged':
        case 'projectStatusChanged':
            return Number.isSafeInteger(value.notified) && Number(value.notified) >= 0;
        case 'cancel':
            return typeof value.cancelled === 'boolean';
        case 'shutdown':
            return value.stopped === true;
    }
}
