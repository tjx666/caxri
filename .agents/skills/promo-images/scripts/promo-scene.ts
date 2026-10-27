import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { builtinThemeIds } from '@caxri/protocol';
import { z } from 'zod';

import { parseFakeClaudeScript } from '../../../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-script.ts';
import { parseFakeCodexScript } from '../../../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-script.ts';

/**
 * A promo scene: the synthetic Projects, the Agent Sessions and the copy one promo image shows. The capture spec seeds
 * the Projects as Git repositories, plays every Session's prompt against the scripted fake Agents, and the runner
 * composes the captures with the named layout. Everything in it is invented, so the image can be published.
 */

/**
 * Device pixels per CSS pixel of the desktop capture: a `desktop` of 1120x700 is captured at 2240x1400.
 */
export const DESKTOP_CAPTURE_SCALE = 2;

const key = z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/u, 'expected a lowercase key such as "checkout-coupons"');

/**
 * File text as one string or as lines; lines read better in JSON and end with a newline.
 */
const fileText = z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (Array.isArray(value) ? `${value.join('\n')}\n` : value));

const relativePath = z
    .string()
    .min(1)
    .refine(
        (path) => !path.startsWith('/') && !path.split('/').includes('..'),
        'expected a path inside the Project',
    );

const commitSchema = z.strictObject({
    message: z.string().min(1),
    files: z.record(relativePath, fileText),
});

const projectSchema = z.strictObject({
    key,
    /**
     * The folder name, which is also the Project title the app shows.
     */
    name: z.string().regex(/^[\w.-]+$/u, 'expected a folder name'),
    /**
     * The branch checked out after the commits, so the Session shows a working branch.
     */
    branch: z.string().min(1).default('main'),
    commits: z.array(commitSchema).min(1),
    /**
     * Uncommitted changes on top of the commits: the edits the Agents report, so Source Control agrees with the Chat.
     * `null` deletes the file.
     */
    changes: z.record(relativePath, fileText.nullable()).default({}),
});

const sessionSchema = z.strictObject({
    key,
    project: key,
    agent: z.enum(['claude', 'codex']),
    title: z.string().min(1),
    /**
     * Sent as the first message; the Agent's script must have a turn with exactly this prompt.
     */
    prompt: z.string().min(1),
    /**
     * The activity state to wait for. `waiting` needs an `approval` step, `failed` a `fail` step, and `running` a
     * `hold` step, which the capture keeps in place until both captures are done.
     */
    expect: z.enum(['completed', 'waiting', 'running', 'failed']),
    /**
     * Whether the finished turn is acknowledged, so the Session leaves the unread state.
     */
    read: z.boolean().default(false),
});

const sceneSchema = z
    .strictObject({
        name: key,
        layout: z.literal('hero-desktop-mobile'),
        /**
         * Logical CSS pixels of the composed image; the PNG is twice this size.
         */
        canvas: z.strictObject({
            width: z.number().int().min(400),
            height: z.number().int().min(300),
        }),
        copy: z.strictObject({
            headline: z.string().min(1),
            subhead: z.string().min(1).optional(),
        }),
        theme: z.enum(builtinThemeIds),
        desktop: z.strictObject({
            /**
             * Window content size in CSS pixels, captured at {@link DESKTOP_CAPTURE_SCALE}.
             */
            width: z.number().int().min(960),
            height: z.number().int().min(640),
            /**
             * The Session the desktop window shows.
             */
            session: key,
            /**
             * The Secondary Side Bar tab to show, by its accessible name (`Files`, `Git`, ...); the app's default when
             * omitted.
             */
            panel: z.string().min(1).optional(),
        }),
        mobile: z.strictObject({
            /**
             * The host name the paired phone shows instead of this machine's name.
             */
            hostName: z.string().min(1),
            screen: z.literal('sessions'),
        }),
        /**
         * Scripted fake Agent turns, as paths relative to the scene file.
         */
        agents: z.strictObject({
            claude: z.string().min(1).optional(),
            codex: z.string().min(1).optional(),
        }),
        projects: z.array(projectSchema).min(1),
        sessions: z.array(sessionSchema).min(1),
    })
    .superRefine((scene, context) => {
        const issue = (path: Array<number | string>, message: string) =>
            context.addIssue({ code: 'custom', path, message });
        const projectKeys = new Set<string>();
        scene.projects.forEach((project, index) => {
            if (projectKeys.has(project.key))
                issue(['projects', index, 'key'], `repeats "${project.key}"`);
            projectKeys.add(project.key);
        });
        const sessionKeys = new Set<string>();
        scene.sessions.forEach((session, index) => {
            if (sessionKeys.has(session.key))
                issue(['sessions', index, 'key'], `repeats "${session.key}"`);
            sessionKeys.add(session.key);
            if (!projectKeys.has(session.project))
                issue(['sessions', index, 'project'], `names no project "${session.project}"`);
            if (!scene.agents[session.agent])
                issue(['sessions', index, 'agent'], `needs agents.${session.agent}`);
        });
        if (!sessionKeys.has(scene.desktop.session))
            issue(['desktop', 'session'], `names no session "${scene.desktop.session}"`);
    });

export type PromoScene = z.output<typeof sceneSchema>;
export type PromoSceneProject = PromoScene['projects'][number];
export type PromoSceneSession = PromoScene['sessions'][number];

/**
 * A checked scene and what playing it needs.
 */
export interface ParsedPromoScene {
    scene: PromoScene;
    /**
     * Control files the scripted `hold` steps of the scene's prompts wait on; the capture creates them before launch
     * and removes them once both captures are done.
     */
    holds: string[];
}

/**
 * A scene with its Agent scripts resolved to absolute paths.
 */
export interface LoadedPromoScene extends ParsedPromoScene {
    scripts: Partial<Record<PromoSceneSession['agent'], string>>;
}

/**
 * The step a Session's expected state needs in its scripted turn.
 */
const REQUIRED_STEP = {
    completed: undefined,
    waiting: 'approval',
    running: 'hold',
    failed: 'fail',
} as const;

function formatIssues(error: z.ZodError): string {
    return error.issues
        .map((issue) => {
            // A record key's own check ("expected a path inside the Project") sits under zod's generic key issue.
            const message =
                issue.code === 'invalid_key'
                    ? issue.issues.map((inner) => inner.message).join(', ')
                    : issue.message;
            return `${issue.path.join('.') || 'scene'}: ${message}`;
        })
        .join('; ');
}

/**
 * Parses a scene and checks it against its Agent scripts. A prompt with no scripted turn would make the fake reply with
 * canned test text, so it fails here instead of in the published image.
 */
export function parsePromoScene(
    value: unknown,
    scripts: Partial<Record<PromoSceneSession['agent'], unknown>>,
): ParsedPromoScene {
    const parsed = sceneSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid promo scene: ${formatIssues(parsed.error)}`);
    const scene = parsed.data;
    const turns = {
        claude: scripts.claude === undefined ? [] : parseFakeClaudeScript(scripts.claude).turns,
        // Any directory satisfies the `hold` check; the capture passes the real one at launch.
        codex:
            scripts.codex === undefined
                ? []
                : parseFakeCodexScript(scripts.codex, '/promo-control').turns,
    };
    const problems: string[] = [];
    const holds = new Set<string>();
    scene.sessions.forEach((session, index) => {
        const turn = turns[session.agent].find(
            (candidate) => candidate.prompt.trim() === session.prompt.trim(),
        );
        if (!turn) {
            problems.push(`sessions.${index}.prompt: no ${session.agent} turn has this prompt`);
            return;
        }
        for (const candidate of turn.steps)
            if (candidate.kind === 'hold') holds.add(candidate.file);
        const step = REQUIRED_STEP[session.expect];
        if (step && turn.steps.every((candidate) => candidate.kind !== step)) {
            problems.push(
                `sessions.${index}.expect: "${session.expect}" needs a "${step}" step in its turn`,
            );
        }
    });
    if (problems.length > 0) throw new Error(`Invalid promo scene: ${problems.join('; ')}`);
    return { scene, holds: [...holds] };
}

/**
 * Reads a scene file and the Agent scripts it names (relative to the scene file).
 */
export async function loadPromoScene(scenePath: string): Promise<LoadedPromoScene> {
    const absolute = resolve(scenePath);
    const value = JSON.parse(await readFile(absolute, 'utf8')) as {
        agents?: Partial<Record<PromoSceneSession['agent'], unknown>>;
    };
    const paths: LoadedPromoScene['scripts'] = {};
    const contents: Partial<Record<PromoSceneSession['agent'], unknown>> = {};
    for (const agent of ['claude', 'codex'] as const) {
        const relative = value.agents?.[agent];
        if (typeof relative !== 'string') continue;
        const path = resolve(dirname(absolute), relative);
        paths[agent] = path;
        // eslint-disable-next-line no-await-in-loop -- at most two small files
        contents[agent] = JSON.parse(await readFile(path, 'utf8')) as unknown;
    }
    return { ...parsePromoScene(value, contents), scripts: paths };
}
