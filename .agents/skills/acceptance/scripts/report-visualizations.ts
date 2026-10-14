import { z } from 'zod';

import { validateHumanText } from './validate-report';

/**
 * Native `cases[].datasets` + `cases[].visualizations` preserve machine-readable values, theme adaptation, and
 * accessibility that a generated PNG throws away. Local validation keeps a plausible-but-wrong shape from reaching
 * publication with degraded evidence.
 */
const DATASET_FIELD_TYPES = ['boolean', 'category', 'number', 'string', 'temporal'] as const;
const VISUALIZATION_TYPES = [
    'metric-comparison',
    'line-chart',
    'bar-chart',
    'scatter-plot',
    'heatmap',
    'table',
] as const;

/**
 * Caxri publication ceiling on the combined inline rows of one case; larger data belongs in a raw `evidence` artifact.
 */
const INLINE_ROW_LIMIT = 10_000;

const datasetFieldSchema = z.looseObject({
    key: z.string().min(1),
    type: z.enum(DATASET_FIELD_TYPES),
});
const datasetCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const datasetRowSchema = z.record(z.string(), datasetCellSchema);
const datasetSchema = z.looseObject({
    fields: z.array(datasetFieldSchema).min(1),
    id: z.string().min(1),
    rows: z.array(datasetRowSchema),
});

const seriesSchema = z
    .array(
        z.looseObject({
            field: z.string().min(1),
            label: z.string().min(1).optional(),
            style: z.enum(['muted', 'primary', 'accent']).optional(),
        }),
    )
    .min(1);

const visualizationSchema = z.looseObject({
    context: z.string().min(1).optional(),
    dataset: z.string().min(1),
    encoding: z.looseObject({}).optional(),
    id: z.string().min(1),
    title: z.string().min(1).optional(),
    type: z.enum(VISUALIZATION_TYPES),
    version: z.literal(1),
});

export const visualizationCaseSchema = z.looseObject({
    datasets: z.array(datasetSchema).optional(),
    id: z.string().min(1),
    visualizations: z.array(visualizationSchema).optional(),
});

type Dataset = z.infer<typeof datasetSchema>;
type Visualization = z.infer<typeof visualizationSchema>;
type VisualizationCase = z.infer<typeof visualizationCaseSchema>;

/**
 * Encoding keys that name a dataset field, per renderer. Purely descriptive keys (`xLabel`, `unit`, `statistic`,
 * `direction`, `valueLabel`) are deliberately absent: they are free prose the page renders as-is, not field
 * references.
 */
const FIELD_ENCODINGS = {
    'bar-chart': { optional: [], required: ['category'] },
    'heatmap': { optional: [], required: ['x', 'y', 'value'] },
    'line-chart': { optional: [], required: ['x'] },
    'metric-comparison': {
        optional: ['beforeSamples', 'afterSamples'],
        required: ['label', 'before', 'after'],
    },
    'scatter-plot': { optional: ['color', 'label'], required: ['x', 'y'] },
    'table': { optional: [], required: [] },
} as const satisfies Record<
    (typeof VISUALIZATION_TYPES)[number],
    { optional: readonly string[]; required: readonly string[] }
>;

function assertUnique(values: string[], label: string): void {
    const seen = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) throw new Error(`${label} must be unique: ${value}`);
        seen.add(value);
    }
}

function fieldReference(
    encoding: Record<string, unknown>,
    key: string,
    context: string,
): string | undefined {
    const value = encoding[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${context} encoding.${key} must name a dataset field`);
    }
    return value;
}

function seriesFields(encoding: Record<string, unknown>, context: string): string[] {
    const parsed = seriesSchema.safeParse(encoding.series);
    if (!parsed.success)
        throw new Error(`${context} encoding.series must declare at least one field`);
    return parsed.data.map(({ field }) => field);
}

function tableFields(encoding: Record<string, unknown>, context: string): string[] {
    const references: string[] = [];
    if (encoding.columns !== undefined) {
        const columns = z.array(z.string().min(1)).min(1).safeParse(encoding.columns);
        if (!columns.success) throw new Error(`${context} encoding.columns must be non-empty`);
        references.push(...columns.data);
    }
    if (encoding.highlights !== undefined) {
        const highlights = z
            .array(z.looseObject({ field: z.string().min(1), mode: z.enum(['min', 'max']) }))
            .safeParse(encoding.highlights);
        if (!highlights.success) {
            throw new Error(`${context} encoding.highlights entries need field and mode`);
        }
        references.push(...highlights.data.map(({ field }) => field));
    }
    return references;
}

function referencedFields(visualization: Visualization, context: string): string[] {
    const encoding = (visualization.encoding ?? {}) as Record<string, unknown>;
    const { optional, required } = FIELD_ENCODINGS[visualization.type];
    const references: string[] = [];
    for (const key of required) {
        const reference = fieldReference(encoding, key, context);
        if (reference === undefined) {
            throw new Error(`${context} requires encoding.${key}`);
        }
        references.push(reference);
    }
    for (const key of optional) {
        const reference = fieldReference(encoding, key, context);
        if (reference !== undefined) references.push(reference);
    }
    if (visualization.type === 'line-chart' || visualization.type === 'bar-chart') {
        references.push(...seriesFields(encoding, context));
    } else if (visualization.type === 'table') {
        references.push(...tableFields(encoding, context));
    }
    return references;
}

function validateDataset(dataset: Dataset, context: string): Set<string> {
    const keys = dataset.fields.map(({ key }) => key);
    assertUnique(keys, `${context} dataset ${dataset.id} field keys`);
    const declared = new Set(keys);
    for (const [index, row] of dataset.rows.entries()) {
        for (const key of Object.keys(row)) {
            if (!declared.has(key)) {
                throw new Error(
                    `${context} dataset ${dataset.id} row ${index} uses undeclared field: ${key}`,
                );
            }
        }
    }
    return declared;
}

/**
 * Validates one case's structured visualizations against its inline datasets. Called from `finalize`, so a case without
 * `datasets`/`visualizations`, the common Caxri screenshot round, costs nothing.
 */
export function validateCaseVisualizations(input: VisualizationCase): void {
    const { datasets = [], id, visualizations = [] } = input;
    if (datasets.length === 0 && visualizations.length === 0) return;
    const context = `Case ${id}`;
    assertUnique(
        datasets.map((dataset) => dataset.id),
        `${context} dataset ids`,
    );
    assertUnique(
        visualizations.map((visualization) => visualization.id),
        `${context} visualization ids`,
    );

    const totalRows = datasets.reduce((total, dataset) => total + dataset.rows.length, 0);
    if (totalRows > INLINE_ROW_LIMIT) {
        throw new Error(`${context} inline dataset rows exceed ${INLINE_ROW_LIMIT}`);
    }

    const fieldsByDataset = new Map<string, Set<string>>();
    for (const dataset of datasets) {
        fieldsByDataset.set(dataset.id, validateDataset(dataset, context));
    }

    for (const visualization of visualizations) {
        const label = `${context} visualization ${visualization.id}`;
        const declared = fieldsByDataset.get(visualization.dataset);
        if (!declared) {
            throw new Error(`${label} references an undeclared dataset: ${visualization.dataset}`);
        }
        for (const reference of referencedFields(visualization, label)) {
            if (!declared.has(reference)) {
                throw new Error(`${label} references an undeclared field: ${reference}`);
            }
        }
        if (visualization.title !== undefined) {
            validateHumanText(visualization.title, `${label} title`);
        }
        if (visualization.context !== undefined) {
            validateHumanText(visualization.context, `${label} context`);
        }
    }
}
