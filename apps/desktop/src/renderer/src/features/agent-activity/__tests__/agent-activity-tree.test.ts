import { describe, expect, it } from 'vitest';

import type { AgentActivityGroup, AgentActivityRow } from '../agent-activity-rows';
import {
    flattenAgentActivityRows,
    nextAgentActivityRowId,
    rovingAgentActivityRowId,
} from '../agent-activity-tree';

function group(id: AgentActivityGroup['id'], sessionIds: readonly string[]): AgentActivityGroup {
    return {
        id,
        rows: sessionIds.map((sessionId) => ({ session: { id: sessionId } }) as AgentActivityRow),
    };
}

const GROUPS = [group('attention', ['a', 'b']), group('idle', ['c'])];
const ROWS = flattenAgentActivityRows(GROUPS);

describe('flattenAgentActivityRows', () => {
    it('emits each heading immediately before its own rows', () => {
        expect(ROWS).toEqual([
            { id: 'attention', kind: 'heading' },
            { id: 'a', kind: 'session' },
            { id: 'b', kind: 'session' },
            { id: 'idle', kind: 'heading' },
            { id: 'c', kind: 'session' },
        ]);
    });
});

describe('nextAgentActivityRowId', () => {
    it('steps over a heading rather than landing on it', () => {
        expect(nextAgentActivityRowId(ROWS, 'b', 'ArrowDown')).toBe('c');
        expect(nextAgentActivityRowId(ROWS, 'c', 'ArrowUp')).toBe('b');
    });

    it('stops at both edges instead of wrapping', () => {
        expect(nextAgentActivityRowId(ROWS, 'a', 'ArrowUp')).toBeUndefined();
        expect(nextAgentActivityRowId(ROWS, 'c', 'ArrowDown')).toBeUndefined();
    });

    it('sends Home and End to the first and last Session rows', () => {
        expect(nextAgentActivityRowId(ROWS, 'b', 'Home')).toBe('a');
        expect(nextAgentActivityRowId(ROWS, 'b', 'End')).toBe('c');
    });

    it('recovers to the first row when the remembered row is gone', () => {
        expect(nextAgentActivityRowId(ROWS, 'removed', 'ArrowDown')).toBe('a');
    });

    it('moves nothing in a list with no Session rows', () => {
        expect(nextAgentActivityRowId([], undefined, 'ArrowDown')).toBeUndefined();
    });
});

describe('rovingAgentActivityRowId', () => {
    it('keeps the last focused row', () => {
        expect(rovingAgentActivityRowId(ROWS, 'b', 'a')).toBe('b');
    });

    it('falls back to the selected Session once the focused row is gone', () => {
        expect(rovingAgentActivityRowId(ROWS, 'removed', 'c')).toBe('c');
    });

    it('falls back to the first row when neither is on screen', () => {
        expect(rovingAgentActivityRowId(ROWS, undefined, 'elsewhere')).toBe('a');
    });

    it('never hands the Tab stop to a heading', () => {
        expect(rovingAgentActivityRowId(ROWS, 'attention', undefined)).toBe('a');
    });
});
