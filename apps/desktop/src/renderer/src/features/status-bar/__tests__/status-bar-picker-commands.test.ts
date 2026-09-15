import { afterEach, describe, expect, it } from 'vitest';

import { caxriQueryKey, queryClient } from '../../../queries/client';
import { useWorkbenchStore } from '../../../stores/workbench';
import { canSelectWorkbenchRoot, canSwitchBranch } from '../status-bar-picker-commands';

const sessionId = 'session-1';

function selectSession(): void {
    useWorkbenchStore.setState({
        bootstrap: { selectedSessionId: sessionId, sessions: [{ id: sessionId }] },
    } as never);
}

/**
 * Only the one field both the chip and the gate read. A Session outside a repository gets the same overview with no
 * `repository`, which is exactly the case the gate exists to catch.
 */
function cacheOverview(repo: { branch: string } | undefined): void {
    queryClient.setQueryData(caxriQueryKey('projectStatus.overview', { sessionId }), {
        repository: repo,
    });
}

afterEach(() => {
    useWorkbenchStore.setState({ bootstrap: undefined } as never);
    queryClient.clear();
});

describe('canSwitchBranch', () => {
    it('offers the command once the branch chip has a repository to leave', () => {
        selectSession();
        cacheOverview({ branch: 'main' });
        expect(canSwitchBranch()).toBe(true);
    });

    it('withholds it for a Session outside a repository, where the chip does not render', () => {
        selectSession();
        cacheOverview(undefined);
        expect(canSwitchBranch()).toBe(false);
    });

    it('withholds it while the overview is still loading, rather than opening an empty picker', () => {
        selectSession();
        expect(canSwitchBranch()).toBe(false);
    });

    it('withholds it with no Session selected', () => {
        cacheOverview({ branch: 'main' });
        expect(canSwitchBranch()).toBe(false);
    });
});

describe('canSelectWorkbenchRoot', () => {
    it('offers the command for any selected Session, because the chip always renders', () => {
        selectSession();
        expect(canSelectWorkbenchRoot()).toBe(true);
    });

    it('withholds it with no Session selected', () => {
        expect(canSelectWorkbenchRoot()).toBe(false);
    });
});
