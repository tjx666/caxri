import { describe, expect, it } from 'vitest';

import { validateCaseVisualizations, visualizationCaseSchema } from '../report-visualizations';

const METRIC_DATASET = {
    fields: [
        { key: 'metric', type: 'string' },
        { key: 'before', type: 'number' },
        { key: 'after', type: 'number' },
    ],
    id: 'render-counts',
    rows: [{ after: 2, before: 11, metric: '会话切换渲染次数' }],
};

const METRIC_VIEW = {
    dataset: 'render-counts',
    encoding: { after: 'after', before: 'before', label: 'metric' },
    id: 'render-comparison',
    title: '会话切换前后的渲染次数',
    type: 'metric-comparison',
    version: 1,
};

function validate(input: unknown): void {
    validateCaseVisualizations(visualizationCaseSchema.parse(input));
}

describe('Acceptance structured visualizations', () => {
    it('accepts a case with no structured data at all', () => {
        expect(() => validate({ id: 'plain-case' })).not.toThrow();
    });

    it('accepts a dataset paired with a renderer that encodes its declared fields', () => {
        expect(() =>
            validate({
                datasets: [METRIC_DATASET],
                id: 'render-case',
                visualizations: [METRIC_VIEW],
            }),
        ).not.toThrow();
    });

    it('rejects a visualization that references an undeclared dataset', () => {
        expect(() =>
            validate({
                datasets: [METRIC_DATASET],
                id: 'render-case',
                visualizations: [{ ...METRIC_VIEW, dataset: 'missing-dataset' }],
            }),
        ).toThrow('references an undeclared dataset: missing-dataset');
    });

    it('rejects an encoding that names a field the dataset never declared', () => {
        expect(() =>
            validate({
                datasets: [METRIC_DATASET],
                id: 'render-case',
                visualizations: [
                    { ...METRIC_VIEW, encoding: { ...METRIC_VIEW.encoding, after: 'candidate' } },
                ],
            }),
        ).toThrow('references an undeclared field: candidate');
    });

    it('rejects a renderer that omits a required encoding key', () => {
        expect(() =>
            validate({
                datasets: [METRIC_DATASET],
                id: 'render-case',
                visualizations: [
                    { ...METRIC_VIEW, encoding: { before: 'before', label: 'metric' } },
                ],
            }),
        ).toThrow('requires encoding.after');
    });

    it('rejects a line chart without at least one series field', () => {
        expect(() =>
            validate({
                datasets: [
                    {
                        fields: [
                            { key: 'step', type: 'number' },
                            { key: 'latency', type: 'number' },
                        ],
                        id: 'startup',
                        rows: [{ latency: 820, step: 1 }],
                    },
                ],
                id: 'startup-case',
                visualizations: [
                    {
                        dataset: 'startup',
                        encoding: { series: [], x: 'step' },
                        id: 'startup-trend',
                        type: 'line-chart',
                        version: 1,
                    },
                ],
            }),
        ).toThrow('encoding.series must declare at least one field');
    });

    it('rejects a row key the dataset never declared', () => {
        expect(() =>
            validate({
                datasets: [{ ...METRIC_DATASET, rows: [{ after: 2, before: 11, candidate: 3 }] }],
                id: 'render-case',
                visualizations: [METRIC_VIEW],
            }),
        ).toThrow('row 0 uses undeclared field: candidate');
    });

    it('rejects duplicate dataset and visualization ids', () => {
        expect(() =>
            validate({
                datasets: [METRIC_DATASET, METRIC_DATASET],
                id: 'render-case',
                visualizations: [METRIC_VIEW],
            }),
        ).toThrow('dataset ids must be unique: render-counts');
        expect(() =>
            validate({
                datasets: [METRIC_DATASET],
                id: 'render-case',
                visualizations: [METRIC_VIEW, METRIC_VIEW],
            }),
        ).toThrow('visualization ids must be unique: render-comparison');
    });

    it('requires the reviewer-facing title and context to follow the report language contract', () => {
        expect(() =>
            validate({
                datasets: [METRIC_DATASET],
                id: 'render-case',
                visualizations: [{ ...METRIC_VIEW, title: 'Render comparison' }],
            }),
        ).toThrow('title must be primarily Chinese');
    });

    it('accepts a table whose encoding is omitted entirely', () => {
        expect(() =>
            validate({
                datasets: [METRIC_DATASET],
                id: 'render-case',
                visualizations: [
                    {
                        dataset: 'render-counts',
                        id: 'render-table',
                        type: 'table',
                        version: 1,
                    },
                ],
            }),
        ).not.toThrow();
    });

    it('rejects a table highlight without its aggregation mode', () => {
        expect(() =>
            validate({
                datasets: [METRIC_DATASET],
                id: 'render-case',
                visualizations: [
                    {
                        dataset: 'render-counts',
                        encoding: { highlights: [{ field: 'after' }] },
                        id: 'render-table',
                        type: 'table',
                        version: 1,
                    },
                ],
            }),
        ).toThrow('encoding.highlights entries need field and mode');
    });
});
