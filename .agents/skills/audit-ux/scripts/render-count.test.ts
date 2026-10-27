import { describe, expect, it, vi } from 'vitest';

import type { RenderInstanceRow } from './render-count';
import {
    collectRenderSample,
    formatRenderTable,
    scopeRenderSample,
    summarizeRenderSample,
} from './render-count';
import { parseRenderCountOptions } from './render-count-options';

function row(overrides: Partial<RenderInstanceRow> & { name: string }): RenderInstanceRow {
    return {
        firstMs: 0,
        hidden: false,
        instance: 1,
        lastMs: 0,
        mounts: 1,
        updates: 0,
        ...overrides,
    };
}

describe('render-count options', () => {
    it('labels each command by default and bounds the window with a settle period', () => {
        expect(parseRenderCountOptions(['boot'])).toMatchObject({
            command: 'boot',
            label: 'boot',
            seconds: 20,
            settleMs: 1500,
        });
        expect(
            parseRenderCountOptions([
                'sample',
                '--label',
                'session-switch',
                '--seconds',
                '30',
                '--settle-ms',
                '2500',
            ]),
        ).toMatchObject({
            command: 'sample',
            label: 'session-switch',
            seconds: 30,
            settleMs: 2500,
        });
    });

    it('rejects an unknown command, an unknown option, and out-of-range window bounds', () => {
        expect(() => parseRenderCountOptions(['measure'])).toThrow('Unknown command: measure');
        expect(() => parseRenderCountOptions(['boot', '--fast'])).toThrow('Unknown option: --fast');
        expect(() => parseRenderCountOptions(['sample', '--seconds', '999'])).toThrow(
            '--seconds must be an integer between 1 and 120',
        );
        expect(() => parseRenderCountOptions(['sample', '--settle-ms', '10'])).toThrow(
            '--settle-ms must be an integer between 100 and 30000',
        );
    });

    it('refuses a click on the boot command, which reloads the window', () => {
        expect(() => parseRenderCountOptions(['boot', '--click', '.session-card'])).toThrow(
            '--click needs a loaded window',
        );
    });

    it('scopes a sample to one surface only when a component name is given', () => {
        expect(parseRenderCountOptions(['sample', '--within', 'PrimarySidebar'])).toMatchObject({
            command: 'sample',
            within: 'PrimarySidebar',
        });
        expect(parseRenderCountOptions(['sample'])).not.toHaveProperty('within');
    });

    it('targets a secondary window only when a URL substring is given', async () => {
        const options = parseRenderCountOptions(['sample', '--url', 'caxri-bot']);
        expect(options).toMatchObject({ command: 'sample', url: 'caxri-bot' });
        expect(parseRenderCountOptions(['sample'])).not.toHaveProperty('url');

        // The connection fails right after target selection; only the selection arguments matter here.
        const connect = vi.fn(() => Promise.reject(new Error('stop after selection')));
        await expect(
            collectRenderSample(options as Exclude<typeof options, 'help'>, connect),
        ).rejects.toThrow('stop after selection');
        expect(connect).toHaveBeenCalledWith(9233, 'caxri-bot');
    });

    it('returns help for no arguments so a bare run explains itself', () => {
        expect(parseRenderCountOptions([])).toBe('help');
        expect(parseRenderCountOptions(['sample', '--help'])).toBe('help');
    });
});

describe('render-count summary', () => {
    it('ranks by total renders and keeps mounts ahead of an equally busy update wave', () => {
        const summary = summarizeRenderSample([
            row({ mounts: 0, name: 'StatusBar', updates: 4 }),
            row({ mounts: 4, name: 'FileRow', updates: 0 }),
            row({ instance: 2, mounts: 1, name: 'Terminal', updates: 20 }),
        ]);

        expect(summary.rows.map(({ name }) => name)).toEqual(['Terminal', 'FileRow', 'StatusBar']);
        expect(summary).toMatchObject({ commits: 29, instances: 3, mounts: 5, updates: 24 });
    });

    it('puts a late-starting second instance ahead of a same-wave list', () => {
        const summary = summarizeRenderSample([
            row({ firstMs: 90, instance: 1, name: 'ControlledViewProvider' }),
            row({ firstMs: 2400, instance: 2, name: 'ControlledViewProvider' }),
            row({ firstMs: 95, instance: 3, name: 'FileTreeItem' }),
            row({ firstMs: 96, instance: 4, name: 'FileTreeItem' }),
            row({ firstMs: 97, instance: 5, name: 'PrimarySidebar' }),
        ]);

        expect(summary.repeatedComponents).toEqual([
            { firstMs: [90, 2400], instances: 2, name: 'ControlledViewProvider' },
            { firstMs: [95, 96], instances: 2, name: 'FileTreeItem' },
        ]);
    });

    it('counts instances whose DOM node has no box, which the screenshot layer cannot see', () => {
        const summary = summarizeRenderSample([
            row({ hidden: true, name: 'FileRow', updates: 9 }),
            row({ hidden: false, instance: 2, name: 'FileRow', updates: 9 }),
        ]);

        expect(summary.hiddenInstances).toBe(1);
    });
});

describe('render-count scope', () => {
    it('keeps the surface subtree in the table and the whole window beside it', () => {
        const { scoped, window } = scopeRenderSample(
            [
                row({ mounts: 0, name: 'ActiveSessionRow', updates: 2, within: true }),
                row({ instance: 2, mounts: 0, name: 'PaneView', updates: 5, within: false }),
            ],
            'PrimarySidebar',
        );

        expect(scoped).toMatchObject({ commits: 2, instances: 1, updates: 2 });
        expect(window).toMatchObject({ commits: 7, instances: 2, updates: 7 });
        expect(
            formatRenderTable(
                scoped,
                { settled: true, windowMs: 1800 },
                {
                    label: 'session-switch',
                    limit: 5,
                    scope: { name: 'PrimarySidebar', window: window! },
                },
            ),
        ).toContain('within=PrimarySidebar (window: instances=2 commits=7 mounts=0 updates=7)');
    });

    it('summarizes the whole sample when no scope was requested', () => {
        const rows = [row({ name: 'PaneView', updates: 3 })];

        expect(scopeRenderSample(rows, undefined)).toEqual({
            scoped: summarizeRenderSample(rows),
        });
    });
});

describe('render-count table', () => {
    it('labels the scenario, keys rows by instance, and notes the truncated tail', () => {
        const summary = summarizeRenderSample([
            row({ mounts: 1, name: 'PrimarySidebar', updates: 7 }),
            row({ instance: 2, mounts: 1, name: 'PrimarySidebar', updates: 3 }),
        ]);

        const table = formatRenderTable(
            summary,
            { settled: true, windowMs: 3200 },
            { label: 'panel-switch', limit: 1 },
        );

        expect(table).toContain(
            'scenario=panel-switch windowMs=3200 settled=yes instances=2 commits=12',
        );
        expect(table).toContain('PrimarySidebar#1');
        expect(table).toContain('… 1 more instances (use --json for all)');
        expect(table).toContain(
            'repeated components (name×instances@firstMs): PrimarySidebar×2@0-0',
        );
    });

    it('marks a run that never went quiet, so the counts are not read as complete', () => {
        const summary = summarizeRenderSample([row({ name: 'Terminal', updates: 400 })]);

        expect(
            formatRenderTable(
                summary,
                { settled: false, windowMs: 20_000 },
                { label: 'refresh-click', limit: 10 },
            ),
        ).toContain('settled=no');
    });
});
