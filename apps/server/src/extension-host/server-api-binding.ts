import type { CancellationToken, ProjectStatusSummary } from 'caxri';

import type { ExtensionHostMessage } from './protocol';
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

export function requestProjectStatus(
    request: ServerApiRequester,
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
        params: { ...(refreshToken && { refreshToken }) },
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
