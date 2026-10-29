import type { MethodResult, ParametersArgument } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { queryClient } from '../../queries/client';

function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['secrets.list'] });
    void queryClient.invalidateQueries({ queryKey: ['secrets.requests.list'] });
}

/**
 * Saves or replaces one secret. The list also refreshes on `agentSecrets.changed`; refreshing here shows the change in
 * this window without waiting for the event.
 */
export async function saveAgentSecret(
    ...arguments_: ParametersArgument<'secrets.set'>
): Promise<MethodResult<'secrets.set'>> {
    const saved = await caxri.request('secrets.set', ...arguments_);
    refresh();
    return saved;
}

export async function deleteAgentSecret(
    ...arguments_: ParametersArgument<'secrets.delete'>
): Promise<MethodResult<'secrets.delete'>> {
    const result = await caxri.request('secrets.delete', ...arguments_);
    refresh();
    return result;
}

export async function answerAgentSecretRequest(
    ...arguments_: ParametersArgument<'secrets.requests.answer'>
): Promise<MethodResult<'secrets.requests.answer'>> {
    const result = await caxri.request('secrets.requests.answer', ...arguments_);
    refresh();
    return result;
}
