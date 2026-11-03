import { useMemo } from 'react';

import { useSessionViewState } from '../../lib/session-view-store';
import { useHardwareBack } from '../../lib/use-hardware-back';
import type { MobileTheme } from '../../theme/tokens';
import { ChangesDiff } from './changes-diff';
import type { ChangedFile, ChangesMode } from './changes-model';
import { changesModeStore, openDiffStore } from './changes-navigation';
import { ChangesView } from './changes-view';
import { useChangesDiff, useChangesList } from './use-changes';

export const ChangesPanel = ({
    canAskAgent,
    list,
    onAskAgentToCommit,
    sessionId,
    theme,
}: {
    canAskAgent: boolean;
    /**
     * The Working Tree list the Session header also counts from; commit and pull request lists are read here.
     */
    list: ReturnType<typeof useChangesList>;
    onAskAgentToCommit: () => void;
    sessionId: string;
    theme: MobileTheme;
}) => {
    const [file, update] = useSessionViewState(openDiffStore, sessionId);
    const [mode, updateMode] = useSessionViewState(changesModeStore, sessionId);
    const modeList = useChangesList(mode !== 'working' && !list.state.isStale, sessionId, mode, {
        shouldSubscribe: false,
    });
    const shown = mode === 'working' ? list : modeList;
    const setFile = (next: ChangedFile | null): void => update(() => next);
    const setMode = (next: ChangesMode): void => updateMode(() => next);
    const diff = useChangesDiff(file !== null, sessionId, file, mode);
    // Hardware Back closes the open diff before it leaves the Session.
    const closeDiff = useMemo(
        () =>
            file === null
                ? null
                : (): boolean => {
                      update(() => null);
                      return true;
                  },
        [file, update],
    );
    useHardwareBack(closeDiff);
    return file ? (
        <ChangesDiff
            onBack={() => setFile(null)}
            onRefresh={() => {
                shown.refresh();
                diff.refresh();
            }}
            onRetry={diff.refresh}
            path={file.path}
            state={diff.state}
            theme={theme}
        />
    ) : (
        <ChangesView
            canAskAgent={canAskAgent}
            mode={mode}
            onAskAgentToCommit={onAskAgentToCommit}
            onModeChange={setMode}
            onOpenFile={setFile}
            onRefresh={shown.refresh}
            state={shown.state}
            theme={theme}
        />
    );
};
