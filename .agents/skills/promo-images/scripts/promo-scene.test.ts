import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPromoScene, parsePromoScene } from './promo-scene';

const claude = {
    turns: [
        { prompt: 'Add coupons.', steps: [{ kind: 'text', text: 'Done.' }] },
        {
            prompt: 'Run the migration.',
            steps: [
                { kind: 'approval', name: 'Bash', input: { command: 'make migrate' }, output: '' },
            ],
        },
    ],
};
const codex = {
    turns: [
        {
            prompt: 'Round invoices.',
            steps: [
                { kind: 'hold', file: 'promo-hold-invoices' },
                { kind: 'message', text: 'Done.' },
            ],
        },
    ],
};

function scene(overrides: Record<string, unknown> = {}) {
    return {
        name: 'demo',
        layout: 'hero-desktop-mobile',
        canvas: { width: 1200, height: 675 },
        copy: { headline: 'Headline' },
        theme: 'dracula',
        desktop: { width: 1120, height: 700, session: 'coupons' },
        mobile: { hostName: 'Studio Mac', screen: 'sessions' },
        agents: { claude: 'claude.json', codex: 'codex.json' },
        projects: [
            {
                key: 'shop',
                name: 'shop',
                commits: [{ message: 'Start', files: { 'src/a.ts': ['export const a = 1;'] } }],
            },
        ],
        sessions: [
            {
                key: 'coupons',
                project: 'shop',
                agent: 'claude',
                title: 'Coupons',
                prompt: 'Add coupons.',
                expect: 'completed',
            },
            {
                key: 'invoices',
                project: 'shop',
                agent: 'codex',
                title: 'Invoices',
                prompt: ' Round invoices. ',
                expect: 'running',
            },
        ],
        ...overrides,
    };
}

describe('parsePromoScene', () => {
    it('applies defaults, joins file lines, and collects the hold files', () => {
        const parsed = parsePromoScene(scene(), { claude, codex });
        const [project] = parsed.scene.projects;
        expect(project.branch).toBe('main');
        expect(project.changes).toEqual({});
        expect(project.commits[0]?.files['src/a.ts']).toBe('export const a = 1;\n');
        expect(parsed.scene.sessions[0]?.read).toBe(false);
        expect(parsed.holds).toEqual(['promo-hold-invoices']);
    });

    it('rejects references that point nowhere', () => {
        const broken = scene({
            desktop: { width: 1120, height: 700, session: 'missing' },
            agents: { claude: 'claude.json' },
        });
        expect(() => parsePromoScene(broken, { claude })).toThrow(
            /sessions\.1\.agent: needs agents\.codex.*desktop\.session: names no session "missing"/u,
        );
    });

    it('rejects a path that leaves the Project', () => {
        const project = {
            key: 'shop',
            name: 'shop',
            commits: [{ message: 'Start', files: { '../outside.ts': 'x' } }],
        };
        expect(() => parsePromoScene(scene({ projects: [project] }), { claude, codex })).toThrow(
            /expected a path inside the Project/u,
        );
    });

    it('rejects a prompt no scripted turn plays, since the fake would answer with canned text', () => {
        const sessions = [
            {
                key: 'coupons',
                project: 'shop',
                agent: 'claude',
                title: 'Coupons',
                prompt: 'Add coupon codes.',
                expect: 'completed',
            },
        ];
        expect(() => parsePromoScene(scene({ sessions }), { claude, codex })).toThrow(
            'sessions.0.prompt: no claude turn has this prompt',
        );
    });

    it('rejects an expected state its turn cannot reach', () => {
        const sessions = [
            {
                key: 'coupons',
                project: 'shop',
                agent: 'claude',
                title: 'Coupons',
                prompt: 'Add coupons.',
                expect: 'waiting',
            },
        ];
        expect(() => parsePromoScene(scene({ sessions }), { claude, codex })).toThrow(
            'sessions.0.expect: "waiting" needs a "approval" step in its turn',
        );
    });
});

describe('loadPromoScene', () => {
    it('loads the README hero with its scripts', async () => {
        const loaded = await loadPromoScene(
            join(import.meta.dirname, '..', 'scenes', 'readme-hero.json'),
        );
        expect(loaded.scene.name).toBe('readme-hero');
        expect(loaded.scripts.claude).toMatch(/readme-hero\.claude\.json$/u);
        expect(loaded.scripts.codex).toMatch(/readme-hero\.codex\.json$/u);
        expect(loaded.holds).toEqual(['promo-hold-invoice-rounding']);
    });
});
