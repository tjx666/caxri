import { memo } from 'react';

import { ActiveSessionRow } from './active-session-row';

/**
 * {@link ActiveSessionRow} behind a memo boundary, for the lists that render rows from a `.map()` (the Project groups,
 * the Pinned group, and a host's nested Sessions). Shared so the three lists cannot drift into different row
 * boundaries. See the component for the props shape the boundary depends on.
 */
export const MemoizedActiveSessionRow = memo(ActiveSessionRow);
