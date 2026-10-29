import type { AppSettings } from '@caxri/protocol';
import { agentProviderIds, appSettingsFileSchema } from '@caxri/protocol';
import { parseJsonc } from '@caxri/system';
import { applyEdits, modify } from 'jsonc-parser';

import { JSONC_FORMATTING_OPTIONS } from './reconcile';

/**
 * The Settings editor persists a debounced full JSONC draft, while action receipts update MRU independently. A draft
 * prepared before a receipt must not erase that newer product-owned history when its queued write runs later. External
 * file edits still use the watcher path and can intentionally replace the history. The caller validates the returned
 * source through its own prepare step before writing.
 */
export function preserveRecentAgentActions(source: string, current: AppSettings): string {
    const candidate = appSettingsFileSchema.parse(parseJsonc(source));
    let mergedSource = source;
    for (const provider of agentProviderIds) {
        const currentRecent = current['agents.providers'][provider].actions.recent;
        const candidateRecent = candidate['agents.providers'][provider].actions.recent;
        if (
            currentRecent.invocations.length === 0 ||
            (currentRecent.invocations.length === candidateRecent.invocations.length &&
                currentRecent.invocations.every(
                    (invocation, index) => invocation === candidateRecent.invocations[index],
                ))
        )
            continue;
        mergedSource = applyEdits(
            mergedSource,
            modify(
                mergedSource,
                ['agents.providers', provider, 'actions', 'recent'],
                currentRecent,
                { formattingOptions: JSONC_FORMATTING_OPTIONS },
            ),
        );
    }
    return mergedSource;
}
