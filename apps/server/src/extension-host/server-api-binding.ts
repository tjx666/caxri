import type { CancellationToken, ProjectStatusSummary } from 'caxri';

import type { ExtensionHostMessage, ExtensionViewEventScope } from './protocol';
import { MAX_EXTENSION_PROJECT_STATUS_REFRESH_TOKEN_LENGTH } from './protocol';
import type { ServerApiRequestInput } from './server-api-request';
import { requestServerApi as sendServerApiRequest } from './server-api-request';

export interface ServerApiBindingContext {
    extensionId: string;
    generation: number;
    apiToken: string;
    assertCurrent(): void;
    isApiTokenCurrent(apiToken: string): boolean;
    send(message: ExtensionHostMessage): void;
}

export type ServerApiRequester = <Result>(
    request: ServerApiRequestInput,
    token?: CancellationToken,
) => Promise<Result>;

export function createServerApiRequester(context: ServerApiBindingContext): ServerApiRequester {
    return <Result>(request: ServerApiRequestInput, token?: CancellationToken) =>
        sendServerApiRequest<Result>(context, request, token);
}

/**
 * Reads Project Status for the Session the running provider call or command is scoped to. Outside any host-supplied
 * scope the Server answers with an empty "no Session" summary rather than guessing the focused window's Session.
 */
export function requestProjectStatus(
    request: ServerApiRequester,
    context: ExtensionViewEventScope,
    refreshToken?: string,
): Promise<ProjectStatusSummary> {
    if (
        refreshToken !== undefined &&
        (refreshToken.length === 0 ||
            refreshToken.length > MAX_EXTENSION_PROJECT_STATUS_REFRESH_TOKEN_LENGTH)
    )
        throw Object.assign(new Error('Project Status refresh token is invalid'), {
            code: 'PROVIDER_FAILED',
        });
    return request({
        method: 'workspace.getProjectStatus',
        params: { context, ...(refreshToken && { refreshToken }) },
    });
}

export function requestConfig<Value>(
    request: ServerApiRequester,
    key: string,
): Promise<Value | undefined> {
    if (key.length === 0 || key.length > 200)
        throw Object.assign(new Error('Configuration key is invalid'), {
            code: 'PROVIDER_FAILED',
        });
    return request({ method: 'workspace.getConfiguration', params: { key } });
}
