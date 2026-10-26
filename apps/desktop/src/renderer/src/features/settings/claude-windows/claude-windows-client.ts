import type { MethodResult, ParametersArgument } from '@caxri/protocol';

import { caxri } from '../../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../../queries/client';

/**
 * Saves the Claude window keeper's settings for the signed-in account and caches the state it answers with, so the card
 * shows the new schedule before the `claudeWindow.changed` refresh arrives.
 */
export async function updateClaudeWindows(
    ...arguments_: ParametersArgument<'claudeWindow.update'>
): Promise<MethodResult<'claudeWindow.update'>> {
    const state = await caxri.request('claudeWindow.update', ...arguments_);
    queryClient.setQueryData(caxriQueryKey('claudeWindow.status', { refresh: false }), state);
    return state;
}
