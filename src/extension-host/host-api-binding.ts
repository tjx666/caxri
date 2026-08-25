import type { CancellationToken, ProjectStatusSummary } from 'caxri';

import type { ExtensionHostMessage } from '../shared/extension-host-protocol';
import { MAX_EXTENSION_PROJECT_STATUS_REFRESH_TOKEN_LENGTH } from '../shared/extension-host-protocol';
import type { HostApiRequestInput } from './host-api-request';
import { requestHostApi as sendHostApiRequest } from './host-api-request';

export interface HostApiBindingContext {
    extensionId: string;
    generation: number;
    apiToken: string;
    assertCurrent(): void;
    isApiTokenCurrent(apiToken: string): boolean;
    send(message: ExtensionHostMessage): void;
}

export type HostApiRequester = <Result>(
    request: HostApiRequestInput,
    token?: CancellationToken,
) => Promise<Result>;

export function createHostApiRequester(context: HostApiBindingContext): HostApiRequester {
    return <Result>(request: HostApiRequestInput, token?: CancellationToken) =>
        sendHostApiRequest<Result>(context, request, token);
}

export function requestProjectStatus(
    request: HostApiRequester,
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
    request: HostApiRequester,
    key: string,
): Promise<Value | undefined> {
    if (key.length === 0 || key.length > 200)
        throw Object.assign(new Error('Configuration key is invalid'), {
            code: 'PROVIDER_FAILED',
        });
    return request({ method: 'workspace.getConfiguration', params: { key } });
}
