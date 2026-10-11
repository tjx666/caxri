import { useEffect, useState } from 'react';

import type { CommanderBoardScope } from '../commander-board';

const STORAGE_KEY = 'caxri.agent-commander.board-scope';

function readScope(): CommanderBoardScope {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'all' ? 'all' : 'commander';
    } catch {
        return 'commander';
    }
}

/**
 * The board's scope, remembered across launches of this window. Defaults to the Commander's own Sessions.
 */
export function useCommanderBoardScope(): [
    CommanderBoardScope,
    (scope: CommanderBoardScope) => void,
] {
    const [scope, setScope] = useState(readScope);
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, scope);
        } catch {
            // Storage-disabled windows keep the scope for this Renderer lifetime.
        }
    }, [scope]);
    return [scope, setScope];
}
