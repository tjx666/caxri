import { useCallback, useRef, useState } from 'react';

import type { DelegationImportIssue, DelegationImportMode } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { isCancelledRequest, pushToast } from '../../../stores/toasts';
import { importDelegationPresets, pickDelegationImportFile } from '../settings-client';
import type { DelegationImportPreview } from './delegation-import-model';
import { importIssues, isStalePreview } from './delegation-import-model';

/**
 * What the import panel shows. `checking` and `ready` are the Server's preview for `mode`; `rejected` carries the
 * value-free issues of a file (or merge result) that cannot be imported; `failed` is any other failure.
 */
export type DelegationImportState =
    | { phase: 'closed' }
    | { phase: 'picking' }
    | {
          phase: 'open';
          fileName?: string;
          mode: DelegationImportMode;
          outcome:
              | { kind: 'applying'; preview: DelegationImportPreview }
              | { kind: 'checking' }
              | { kind: 'failed' }
              | { kind: 'ready'; preview: DelegationImportPreview; isRefreshed: boolean }
              | { kind: 'rejected'; issues: DelegationImportIssue[] }
              | { kind: 'unreadable' };
          sourceText?: string;
      };

/**
 * The import flow: pick a file (Main only reads it), keep its text here, and ask the Server for a preview of the chosen
 * mode. Changing the mode asks again; confirming sends the same text with the preview's revision, and a stale revision
 * refreshes the preview from the kept text for the user to confirm again instead of retrying the write.
 */
export function useDelegationImport() {
    const { t } = useTranslation();
    const [state, setState] = useState<DelegationImportState>({ phase: 'closed' });
    const latest = useRef(0);

    const preview = useCallback(
        async (
            sourceText: string,
            mode: DelegationImportMode,
            fileName: string | undefined,
            isRefreshed: boolean,
        ) => {
            const request = ++latest.current;
            const open = { phase: 'open', fileName, mode, sourceText } as const;
            setState({ ...open, outcome: { kind: 'checking' } });
            try {
                const result = await importDelegationPresets({ sourceText, mode, dryRun: true });
                if (request === latest.current)
                    setState({ ...open, outcome: { kind: 'ready', preview: result, isRefreshed } });
            } catch (error) {
                if (request !== latest.current || isCancelledRequest(error)) return;
                const issues = importIssues(error);
                setState({
                    ...open,
                    outcome: issues.length > 0 ? { kind: 'rejected', issues } : { kind: 'failed' },
                });
            }
        },
        [],
    );

    const choose = useCallback(async () => {
        const request = ++latest.current;
        setState({ phase: 'picking' });
        try {
            const picked = await pickDelegationImportFile();
            if (request !== latest.current) return;
            if (picked) await preview(picked.sourceText, 'merge', picked.fileName, false);
            else setState({ phase: 'closed' });
        } catch (error) {
            if (request !== latest.current || isCancelledRequest(error)) return;
            const issues = importIssues(error);
            setState({
                phase: 'open',
                mode: 'merge',
                outcome: issues.length > 0 ? { kind: 'rejected', issues } : { kind: 'unreadable' },
            });
        }
    }, [preview]);

    const setMode = useCallback(
        (mode: DelegationImportMode) => {
            if (state.phase === 'open' && state.sourceText !== undefined && mode !== state.mode)
                void preview(state.sourceText, mode, state.fileName, false);
        },
        [preview, state],
    );

    const apply = useCallback(async () => {
        if (
            state.phase !== 'open' ||
            state.outcome.kind !== 'ready' ||
            state.sourceText === undefined
        )
            return;
        const { sourceText, mode, fileName } = state;
        const { preview: previous } = state.outcome;
        const request = ++latest.current;
        setState({ ...state, outcome: { kind: 'applying', preview: previous } });
        try {
            await importDelegationPresets({
                sourceText,
                mode,
                dryRun: false,
                expectedRevision: previous.revision,
            });
            if (request !== latest.current) return;
            pushToast('success', t('settings.delegationPresets.imported'));
            setState({ phase: 'closed' });
        } catch (error) {
            if (request !== latest.current || isCancelledRequest(error)) return;
            if (isStalePreview(error)) {
                void preview(sourceText, mode, fileName, true);
                return;
            }
            const issues = importIssues(error);
            setState({
                phase: 'open',
                fileName,
                mode,
                sourceText,
                outcome: issues.length > 0 ? { kind: 'rejected', issues } : { kind: 'failed' },
            });
        }
    }, [preview, state, t]);

    const cancel = useCallback(() => {
        latest.current += 1;
        setState({ phase: 'closed' });
    }, []);

    return { state, choose, setMode, apply, cancel };
}
