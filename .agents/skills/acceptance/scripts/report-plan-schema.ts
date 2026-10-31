import { z } from 'zod';

import { acceptanceAgentFixtureIds } from './agent-fixture-ids';
import { stateIsolationSchema } from './case-lifecycle';
import { mobileDeviceSchema } from './mobile-report';
import { planFixtureFields } from './plan-fixtures';
import { isAcceptanceCaseId } from './runtime-state';

export const PRODUCT_SURFACES = ['cli', 'desktop', 'mobile'] as const;

const PROGRAMMATIC_GATE_FIELDS = ['title', 'category', 'method', 'expected'] as const;

/**
 * Phrases that make a plan item a programmatic gate rather than a user outcome. The publication service rejects such a
 * round only at ingest, after the case already ran on a device, so `init` and `finalize` reject it first. Each pattern
 * names an explicit gate (a test suite, lint, type check, build or CI result) so ordinary product words such as "build"
 * or "CI" alone stay allowed, and `verifier: "program"` product checks are unaffected.
 */
const PROGRAMMATIC_GATE_PATTERNS: readonly RegExp[] = [
    /\b(?:unit|integration|regression|snapshot|contract)[ -]tests?\b/iu,
    /\b(?:vitest|eslint|oxlint|tsc|knip|typecheck|type-check|format:check)\b/iu,
    /\blint(?:ing)?\b/iu,
    /\b(?:test|code) coverage\b/iu,
    /\bbun run (?:check|test|lint|typecheck)\b/iu,
    /\b(?:build|CI) (?:is green|passe[sd]|succeed(?:s|ed))\b/iu,
    /\bcompiles\b/iu,
    /单元测试|单测|集成测试|回归测试|快照测试|契约测试|测试覆盖率|类型检查|构建通过|编译通过|CI\s*(?:通过|全绿|变绿)/u,
];

/**
 * Returns the first programmatic-gate phrase found in a plan field, if any.
 */
function programmaticGateIn(text: string): string | undefined {
    for (const pattern of PROGRAMMATIC_GATE_PATTERNS) {
        const match = pattern.exec(text);
        if (match) return match[0];
    }
    return undefined;
}

export const REQUIRED_EVIDENCE_TYPES = [
    'screenshot',
    'gif',
    'video',
    'text',
    'markdown',
    'dom_snapshot',
] as const;
export const MEDIA_SOURCES = [
    'android-framebuffer',
    'ios-simulator-framebuffer',
    'isolated-desktop-renderer',
] as const;
const requiredEvidenceSchema = z.union([
    z.enum(REQUIRED_EVIDENCE_TYPES),
    z.object({
        hint: z.string().optional(),
        source: z.enum(MEDIA_SOURCES).optional(),
        type: z.enum(REQUIRED_EVIDENCE_TYPES),
    }),
]);
export const planItemSchema = z
    .looseObject({
        agentFixture: z.enum(acceptanceAgentFixtureIds).optional(),
        category: z.string().min(1),
        expected: z.string().min(1),
        fixturePreflight: z.literal('terminal').optional(),
        id: z.string().min(1).refine(isAcceptanceCaseId, {
            message: 'Acceptance case id must use ASCII letters, numbers, and hyphens',
        }),
        method: z.string().min(1),
        mobileDevice: mobileDeviceSchema.optional(),
        requiredEvidence: z.array(requiredEvidenceSchema).min(1),
        stateIsolation: stateIsolationSchema.default({ mode: 'isolated' }),
        surface: z.enum(PRODUCT_SURFACES).default('desktop'),
        title: z.string().min(1),
        verifier: z.enum(['agent', 'program', 'llm']).default('agent'),
        ...planFixtureFields,
    })
    .superRefine((item, context) => {
        for (const field of PROGRAMMATIC_GATE_FIELDS) {
            const gate = programmaticGateIn(item[field]);
            if (gate) {
                context.addIssue({
                    code: 'custom',
                    message: `Plan item ${item.id} ${field} names the programmatic gate "${gate}"; an Acceptance check is an outcome a person judges, so report tests, lint, type checks, builds, and CI as one line of report.md instead`,
                    path: [field],
                });
            }
        }
        if (item.surface === 'mobile' && !item.mobileDevice) {
            context.addIssue({
                code: 'custom',
                message: 'A mobile Acceptance case must declare mobileDevice',
                path: ['mobileDevice'],
            });
        }
        if (item.surface !== 'mobile' && item.mobileDevice) {
            context.addIssue({
                code: 'custom',
                message: `A ${item.surface} Acceptance case cannot declare mobileDevice`,
                path: ['mobileDevice'],
            });
        }
    });
