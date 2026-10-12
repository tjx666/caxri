import { describe, expect, it } from 'vitest';

import { translate } from '../../i18n';
import type { PathBrowserEntry, PathBrowserRow } from './path-browser-rows';
import {
    firstSelectablePathBrowserIndex,
    isSelectablePathBrowserRow,
    nextSelectablePathBrowserIndex,
    pathBrowserRows,
} from './path-browser-rows';

function entry(name: string, source: PathBrowserEntry['source']): PathBrowserEntry {
    return { id: name, kind: 'file', name, source };
}

const here = entry('app.ts', 'directory');
const elsewhere = entry('app-menu.ts', 'projectSearch');
const create = { kind: 'file' as const, name: 'app' };

function label(row: PathBrowserRow): string {
    switch (row.kind) {
        case 'create':
            return `create:${row.candidate.name}`;
        case 'entry':
            return `entry:${row.entry.name}`;
        case 'group':
            return `group:${translate(row.label)}`;
        case 'notice':
            return `notice:${translate(row.text)}`;
    }
}

function labels(rows: readonly PathBrowserRow[]): string[] {
    return rows.map(label);
}

describe('Path browser rows', () => {
    it('shows both sources at once instead of hiding one behind the other being empty', () => {
        const rows = pathBrowserRows({
            candidateToCreate: undefined,
            entries: [here, elsewhere],
            isDirectoryTruncated: false,
            query: 'app',
            searchStatus: 'complete',
        });

        expect(labels(rows)).toEqual([
            'group:In this folder',
            'entry:app.ts',
            'group:Elsewhere in this Project',
            'entry:app-menu.ts',
        ]);
    });

    it('keeps the Project group visible when only the current folder matched', () => {
        const rows = pathBrowserRows({
            candidateToCreate: undefined,
            entries: [here],
            isDirectoryTruncated: false,
            query: 'app',
            searchStatus: 'complete',
        });

        expect(labels(rows)).toEqual([
            'group:In this folder',
            'entry:app.ts',
            'group:Elsewhere in this Project',
            'notice:No matching file or folder.',
        ]);
    });

    it('keeps the create action beside a zero-result search rather than instead of it', () => {
        const rows = pathBrowserRows({
            candidateToCreate: create,
            entries: [],
            isDirectoryTruncated: false,
            query: 'app',
            searchStatus: 'complete',
        });

        expect(labels(rows)).toEqual([
            'group:In this folder',
            'notice:No matching file or folder.',
            'group:Elsewhere in this Project',
            'notice:No matching file or folder.',
            'create:app',
        ]);
    });

    it('says the search could not run instead of letting its group read as empty', () => {
        const rows = pathBrowserRows({
            candidateToCreate: undefined,
            entries: [here],
            isDirectoryTruncated: false,
            query: 'app',
            searchStatus: 'unavailable',
        });

        expect(labels(rows)).toEqual([
            'group:In this folder',
            'entry:app.ts',
            'group:Elsewhere in this Project',
            'notice:Project search is unavailable right now.',
        ]);
    });

    it('marks a partial scan so its emptiness is not read as an answer', () => {
        const rows = pathBrowserRows({
            candidateToCreate: undefined,
            entries: [here],
            isDirectoryTruncated: false,
            query: 'app',
            searchStatus: 'incomplete',
        });

        expect(labels(rows).at(-1)).toBe(
            'notice:Only part of this Project was searched. Refine the name.',
        );
    });

    it('shows no placeholder and no headings while the field is empty', () => {
        const rows = pathBrowserRows({
            candidateToCreate: undefined,
            entries: [here],
            isDirectoryTruncated: false,
            query: '',
            searchStatus: 'skipped',
        });

        expect(labels(rows)).toEqual(['entry:app.ts']);
    });

    it('still reports an empty directory listing when no search was asked for', () => {
        const rows = pathBrowserRows({
            candidateToCreate: undefined,
            entries: [],
            isDirectoryTruncated: false,
            query: 'nested/thing',
            searchStatus: 'skipped',
        });

        expect(labels(rows)).toEqual(['notice:No matching file or folder.']);
    });

    it('repeats each group on its own rows, since a heading inside a listbox is never read', () => {
        const grouped = pathBrowserRows({
            candidateToCreate: undefined,
            entries: [here, elsewhere],
            isDirectoryTruncated: false,
            query: 'app',
            searchStatus: 'complete',
        });
        const ungrouped = pathBrowserRows({
            candidateToCreate: undefined,
            entries: [here],
            isDirectoryTruncated: false,
            query: 'app',
            searchStatus: 'skipped',
        });

        expect(
            grouped.flatMap((row) =>
                row.kind === 'entry' ? [row.group && translate(row.group)] : [],
            ),
        ).toEqual(['In this folder', 'Elsewhere in this Project']);
        // One source needs no disambiguation, so nothing is repeated onto the row.
        expect(
            ungrouped.flatMap((row) =>
                row.kind === 'entry' ? [row.group && translate(row.group)] : [],
            ),
        ).toEqual([undefined]);
    });

    it('names a truncated folder once, whether or not a search ran beside it', () => {
        const withoutSearch = pathBrowserRows({
            candidateToCreate: undefined,
            entries: [here],
            isDirectoryTruncated: true,
            query: 'app',
            searchStatus: 'skipped',
        });
        const withSearch = pathBrowserRows({
            candidateToCreate: undefined,
            entries: [here, elsewhere],
            isDirectoryTruncated: true,
            query: 'app',
            searchStatus: 'complete',
        });

        expect(labels(withoutSearch)).toEqual([
            'entry:app.ts',
            'notice:Only part of this folder is shown. Refine or open a narrower folder.',
        ]);
        // The notice sits under the rows it cut off, not at the end of the whole list.
        expect(labels(withSearch)).toEqual([
            'group:In this folder',
            'entry:app.ts',
            'notice:Only part of this folder is shown. Refine or open a narrower folder.',
            'group:Elsewhere in this Project',
            'entry:app-menu.ts',
        ]);
    });

    it('gives every row a key nothing else in the list reuses', () => {
        const rows = pathBrowserRows({
            candidateToCreate: create,
            entries: [here],
            isDirectoryTruncated: true,
            query: 'app',
            searchStatus: 'incomplete',
        });

        const ids = rows.flatMap((row) =>
            row.kind === 'group' || row.kind === 'notice' ? [row.id] : [],
        );
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('steps over headings and notices in both directions', () => {
        const rows = pathBrowserRows({
            candidateToCreate: create,
            entries: [here, elsewhere],
            isDirectoryTruncated: false,
            query: 'app',
            searchStatus: 'complete',
        });

        expect(rows.filter((row) => isSelectablePathBrowserRow(row))).toHaveLength(3);
        const first = firstSelectablePathBrowserIndex(rows);
        expect(labels(rows)[first]).toBe('entry:app.ts');
        const second = nextSelectablePathBrowserIndex(rows, first, 1);
        expect(labels(rows)[second]).toBe('entry:app-menu.ts');
        const third = nextSelectablePathBrowserIndex(rows, second, 1);
        expect(labels(rows)[third]).toBe('create:app');
        expect(nextSelectablePathBrowserIndex(rows, third, 1)).toBe(first);
        expect(nextSelectablePathBrowserIndex(rows, first, -1)).toBe(third);
    });

    it('stays put when the list holds nothing selectable', () => {
        const rows = pathBrowserRows({
            candidateToCreate: undefined,
            entries: [],
            isDirectoryTruncated: false,
            query: 'app',
            searchStatus: 'complete',
        });

        expect(rows.some((row) => isSelectablePathBrowserRow(row))).toBe(false);
        expect(nextSelectablePathBrowserIndex(rows, 0, 1)).toBe(0);
        expect(firstSelectablePathBrowserIndex(rows)).toBe(0);
    });
});
