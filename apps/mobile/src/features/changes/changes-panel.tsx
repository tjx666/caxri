import { useState } from 'react';

import type { MobileTheme } from '../../theme/tokens';
import { ChangesDiff } from './changes-diff';
import type { ChangedFile } from './changes-model';
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
    const [file, setFile] = useState<ChangedFile | null>(null);
    const diff = useChangesDiff(file !== null, sessionId, file);
    return file ? (
        <ChangesDiff
            onBack={() => setFile(null)}
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
