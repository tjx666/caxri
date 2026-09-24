import { execFile } from 'node:child_process';
import process from 'node:process';
import { parseArgs, promisify } from 'node:util';

import { z } from 'zod';

const execFileAsync = promisify(execFile);

/**
 * Single-select fields this script can set, keyed by CLI flag. The value is the Project field name.
 */
const FIELDS = { priority: 'Priority', size: 'Size', status: 'Status' } as const;
type FieldKey = keyof typeof FIELDS;

export interface TrackProjectItemOptions {
    owner: string;
    projectNumber: number;
    url: string;
    values: Partial<Record<FieldKey, string>>;
}

export interface TrackProjectItemDependencies {
    runGitHub: (arguments_: string[]) => Promise<string>;
}

const defaultDependencies: TrackProjectItemDependencies = {
    runGitHub: async (arguments_) => {
        const { stdout } = await execFileAsync('gh', arguments_, { encoding: 'utf8' });
        return stdout;
    },
};

const idSchema = z.object({ id: z.string() });
const optionSchema = z.object({ id: z.string(), name: z.string() });
const selectFieldSchema = z.object({ id: z.string(), options: z.array(optionSchema) }).nullable();
const projectItemSchema = z.object({ id: z.string(), project: idSchema });
const projectItemsSchema = z.object({ nodes: z.array(projectItemSchema) });
const projectSchema = z.object({
    id: z.string(),
    priority: selectFieldSchema,
    size: selectFieldSchema,
    status: selectFieldSchema,
});
const ownerSchema = z.object({ projectV2: projectSchema.nullable() });
const resourceSchema = z.object({ id: z.string(), projectItems: projectItemsSchema });
const lookupSchema = z.object({
    data: z.object({
        repositoryOwner: ownerSchema.nullable(),
        resource: resourceSchema.nullable(),
    }),
});
const addedItemSchema = z.object({ item: idSchema });
const addSchema = z.object({ data: z.object({ addProjectV2ItemById: addedItemSchema }) });
const selectValueSchema = z.object({ name: z.string() }).nullable();
const itemValuesSchema = z.object({
    priority: selectValueSchema,
    size: selectValueSchema,
    status: selectValueSchema,
});
const readBackSchema = z.object({ data: z.object({ node: itemValuesSchema }) });

const selectField = (key: FieldKey) =>
    `${key}: field(name: "${FIELDS[key]}") { ... on ProjectV2SingleSelectField { id options { id name } } }`;
const selectValue = (key: FieldKey) =>
    `${key}: fieldValueByName(name: "${FIELDS[key]}") { ... on ProjectV2ItemFieldSingleSelectValue { name } }`;
const fieldKeys = Object.keys(FIELDS) as FieldKey[];

/**
 * Named `field(name:)` and `fieldValueByName` lookups are not connections, so each request here costs about one GraphQL
 * point. `gh project item-edit --url --field` instead re-reads the whole field catalog on every call, which GitHub
 * bills at ~100 points: filing a batch of issues through it drained the account-wide 5,000-point hourly budget that the
 * user's shell, every Agent, and the Caxri app share.
 */
const LOOKUP_QUERY = `query($url: URI!, $owner: String!, $number: Int!) {
  resource(url: $url) {
    ... on Issue { id projectItems(first: 20) { nodes { id project { id } } } }
    ... on PullRequest { id projectItems(first: 20) { nodes { id project { id } } } }
  }
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner { projectV2(number: $number) { id ${fieldKeys.map(selectField).join(' ')} } }
  }
}`;

async function graphql<T>(
    dependencies: TrackProjectItemDependencies,
    query: string,
    variables: Record<string, string | number>,
    schema: z.ZodType<T>,
): Promise<T> {
    const arguments_ = ['api', 'graphql', '-f', `query=${query}`];
    for (const [name, value] of Object.entries(variables))
        arguments_.push(typeof value === 'number' ? '-F' : '-f', `${name}=${value}`);
    return schema.parse(JSON.parse(await dependencies.runGitHub(arguments_)));
}

/**
 * Adds an issue or pull request to the Project when it is not already there, sets the requested single-select fields in
 * one mutation, and returns the values read back from GitHub.
 */
export async function trackProjectItem(
    options: TrackProjectItemOptions,
    dependencies: TrackProjectItemDependencies = defaultDependencies,
): Promise<Record<FieldKey, string | null>> {
    const { data } = await graphql(
        dependencies,
        LOOKUP_QUERY,
        { number: options.projectNumber, owner: options.owner, url: options.url },
        lookupSchema,
    );
    const project = data.repositoryOwner?.projectV2;
    if (!project) throw new Error(`Project ${options.owner}#${options.projectNumber} not found`);
    if (!data.resource) throw new Error(`${options.url} is not an issue or pull request`);

    const updates = Object.entries(options.values).map(([key, name]) => {
        const field = project[key as FieldKey];
        if (!field) throw new Error(`Project field ${FIELDS[key as FieldKey]} not found`);
        const option = field.options.find((candidate) => candidate.name === name);
        if (!option) {
            const names = field.options.map((candidate) => candidate.name).join(', ');
            throw new Error(
                `${FIELDS[key as FieldKey]} has no option "${name}"; expected one of: ${names}`,
            );
        }
        return { fieldId: field.id, key, optionId: option.id };
    });

    let itemId = data.resource.projectItems.nodes.find(
        (item) => item.project.id === project.id,
    )?.id;
    if (!itemId) {
        const added = await graphql(
            dependencies,
            'mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }',
            { content: data.resource.id, project: project.id },
            addSchema,
        );
        itemId = added.data.addProjectV2ItemById.item.id;
    }

    if (updates.length > 0) {
        const fields = updates
            .map(
                ({ fieldId, key, optionId }) =>
                    `${key}: updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: ${JSON.stringify(fieldId)}, value: { singleSelectOptionId: ${JSON.stringify(optionId)} } }) { projectV2Item { id } }`,
            )
            .join(' ');
        await graphql(
            dependencies,
            `mutation($project: ID!, $item: ID!) { ${fields} }`,
            { item: itemId, project: project.id },
            z.unknown(),
        );
    }

    const readBack = await graphql(
        dependencies,
        `query($item: ID!) { node(id: $item) { ... on ProjectV2Item { ${fieldKeys.map(selectValue).join(' ')} } } }`,
        { item: itemId },
        readBackSchema,
    );
    const { node } = readBack.data;
    return {
        priority: node.priority?.name ?? null,
        size: node.size?.name ?? null,
        status: node.status?.name ?? null,
    };
}

function help(): string {
    return String.raw`Add an issue or pull request to a Project and set its single-select fields

Usage:
  bun run .agents/skills/file-issue/scripts/track-project-item.ts --url ISSUE_URL \
    [--status NAME] [--priority NAME] [--size NAME] [--owner LOGIN] [--project NUMBER]

Defaults: --owner tjx666 --project 2. Prints the Status, Priority, and Size read back from GitHub.`;
}

async function main(arguments_: string[]): Promise<void> {
    const { values } = parseArgs({
        args: arguments_,
        options: {
            help: { type: 'boolean' },
            owner: { default: 'tjx666', type: 'string' },
            priority: { type: 'string' },
            project: { default: '2', type: 'string' },
            size: { type: 'string' },
            status: { type: 'string' },
            url: { type: 'string' },
        },
        strict: true,
    });
    if (values.help) {
        process.stdout.write(`${help()}\n`);
        return;
    }
    if (!values.url) throw new Error('--url is required');
    const projectNumber = Number(values.project);
    if (!Number.isSafeInteger(projectNumber) || projectNumber <= 0)
        throw new Error('--project must be a positive integer');
    const fieldValues: Partial<Record<FieldKey, string>> = {};
    for (const key of fieldKeys) if (values[key]) fieldValues[key] = values[key];
    const result = await trackProjectItem({
        owner: values.owner,
        projectNumber,
        url: values.url,
        values: fieldValues,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
    try {
        await main(process.argv.slice(2));
    } catch (error: unknown) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
