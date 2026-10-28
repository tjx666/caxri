import { useMemo } from 'react';

import { useSessionViewState } from '../../lib/session-view-store';
import { useHardwareBack } from '../../lib/use-hardware-back';
import type { MobileTheme } from '../../theme/tokens';
import { ChangesDiff } from './changes-diff';
import type { ChangedFile } from './changes-model';
import { openDiffStore } from './changes-navigation';
import { ChangesView } from './changes-view';
import type { useChangesList } from './use-changes';
import { useChangesDiff } from './use-changes';

export const ChangesPanel = ({
    canAskAgent,
    list,
    onAskAgentToCommit,
    sessionId,
    theme,
}: {
    canAskAgent: boolean;
    list: ReturnType<typeof useChangesList>;
    onAskAgentToCommit: () => void;
    sessionId: string;
    theme: MobileTheme;
}) => {
    const [file, update] = useSessionViewState(openDiffStore, sessionId);
    const setFile = (next: ChangedFile | null): void => update(() => next);
    const diff = useChangesDiff(file !== null, sessionId, file);
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
                list.refresh();
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
            onAskAgentToCommit={onAskAgentToCommit}
            onOpenFile={setFile}
            onRefresh={list.refresh}
            state={list.state}
            theme={theme}
        />
    );
};
