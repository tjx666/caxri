import type { ComponentType } from 'react';

import type { GlyphProperties as GlyphProperties } from './glyph-frame';
import {
    AgentGlyph,
    BrowserGlyph,
    CommandGlyph,
    CompactGlyph,
    ComputerGlyph,
    EditGlyph,
    ImageGlyph,
    ListGlyph,
    ManageGlyph,
    McpGlyph,
    OtherGlyph,
    PlanGlyph,
    QuestionGlyph,
    ReadGlyph,
    SearchGlyph,
    SkillGlyph,
    StopGlyph,
    ThoughtGlyph,
    WaitGlyph,
    WebGlyph,
    WriteGlyph,
} from './glyphs';
import type { LiveGlyphKind } from './presentation';

/**
 * One live glyph per kind. A new tool kind in `@caxri/protocol` fails this table's type until it gets a glyph. A test
 * run, commit, push, or pull request step is a shell command while it runs, so it types like one until it settles into
 * its own icon.
 */
const LIVE_GLYPHS: Record<LiveGlyphKind, ComponentType<GlyphProperties>> = {
    agent: AgentGlyph,
    browser: BrowserGlyph,
    command: CommandGlyph,
    commit: CommandGlyph,
    compact: CompactGlyph,
    computer: ComputerGlyph,
    edit: EditGlyph,
    image: ImageGlyph,
    list: ListGlyph,
    manage: ManageGlyph,
    mcp: McpGlyph,
    other: OtherGlyph,
    plan: PlanGlyph,
    pullRequest: CommandGlyph,
    push: CommandGlyph,
    question: QuestionGlyph,
    read: ReadGlyph,
    search: SearchGlyph,
    skill: SkillGlyph,
    stop: StopGlyph,
    test: CommandGlyph,
    thought: ThoughtGlyph,
    wait: WaitGlyph,
    web: WebGlyph,
    write: WriteGlyph,
};

/**
 * The animated glyph a running tool shows in place of its still icon, acting out the work: a bookworm for a read, a
 * typewriter for a new file, a snail for a wait. Render it only while the tool runs and `useLoadingStyle` allows it.
 */
export function ToolGlyph({ kind, size }: GlyphProperties & { kind: LiveGlyphKind }) {
    const Glyph = LIVE_GLYPHS[kind];
    return <Glyph size={size} />;
}
