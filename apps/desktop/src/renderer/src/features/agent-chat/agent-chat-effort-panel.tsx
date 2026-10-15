import type { ComponentType } from 'react';
import { useState } from 'react';

import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import type { AgentChatModel, AgentChatModelRequest } from '@caxri/protocol';
import { agentChatEffortLabel } from '@caxri/protocol';
import { ChevronRight, RotateCcw, Workflow, Zap } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { agentChatEffortReset, agentChatEffortStop } from './agent-chat-model-selection';

/**
 * A mode toggle the panel's header offers: Fast mode or Claude Code's ultracode.
 */
export interface AgentChatModeToggle {
    description: string;
    isOn: boolean;
}

/**
 * The thumb is 28px (`size-7`) and sits inside the track at both ends (`thumbAlignment="edge"`), so stop `i` of `n`
 * centers at `14px + (100% - 28px) * i / (n - 1)`.
 */
const THUMB_RADIUS_PX = 14;

/**
 * Twinkles drawn on the filled track while Fast mode is on, as the Codex app does: left and top as percentages of the
 * fill, with a staggered delay so they do not pulse in step.
 */
const SPARKLES = [
    { left: 8, top: 30, delay: 0 },
    { left: 18, top: 70, delay: 600 },
    { left: 31, top: 40, delay: 300 },
    { left: 44, top: 75, delay: 900 },
    { left: 56, top: 25, delay: 150 },
    { left: 68, top: 60, delay: 750 },
    { left: 80, top: 35, delay: 450 },
] as const;

/**
 * The picker's main face, after the Codex app's effort popover: the mode toggles on the left, the effort in the accent
 * color over the model name (which opens the model list), Reset to default on the right, and a slider with one stop per
 * effort the model accepts. Dragging previews the effort in the title; releasing applies it and keeps the panel open. A
 * model without effort control keeps only the header, titled with the model name.
 */
export function AgentChatEffortPanel({
    configure,
    effort,
    fast,
    model,
    modelName,
    onChooseModel,
    ultracode,
}: {
    configure: (change: AgentChatModelRequest) => void;
    effort: string | undefined;
    fast: AgentChatModeToggle | undefined;
    model: AgentChatModel | undefined;
    modelName: string;
    onChooseModel: () => void;
    ultracode: AgentChatModeToggle | undefined;
}) {
    const { t } = useTranslation();
    const [dragged, setDragged] = useState<number>();
    const efforts = model?.efforts ?? [];
    const shownEffort = dragged === undefined ? effort : efforts[dragged];
    const reset = model && agentChatEffortReset(model, effort);
    return (
        <div className="flex flex-col gap-3 p-3">
            <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2">
                <div className="flex items-center gap-1">
                    {fast && (
                        <ModeButton
                            fillsWhenOn
                            icon={Zap}
                            label={t('agentChat.model.fast')}
                            toggle={fast}
                            onChange={(isOn) => configure({ fast: isOn })}
                        />
                    )}
                    {ultracode && (
                        <ModeButton
                            icon={Workflow}
                            label={t('agentChat.model.ultracode')}
                            toggle={ultracode}
                            onChange={(isOn) => configure({ ultracode: isOn })}
                        />
                    )}
                </div>
                <button
                    aria-label={t('agentChat.model.chooseModelFor', { model: modelName })}
                    className="flex min-w-0 cursor-pointer flex-col items-center rounded-md px-3 py-1 outline-none hover:bg-[var(--selection)] focus-visible:bg-[var(--selection)]"
                    type="button"
                    onClick={onChooseModel}
                >
                    {shownEffort && efforts.length > 0 && (
                        <span className="text-[15px] leading-5 font-semibold text-accent">
                            {agentChatEffortLabel(shownEffort, t)}
                        </span>
                    )}
                    <span
                        className={cn(
                            'flex max-w-48 min-w-0 items-center gap-0.5',
                            shownEffort && efforts.length > 0
                                ? 'text-[12px] leading-4 text-muted'
                                : 'text-[13px] leading-5 text-foreground',
                        )}
                    >
                        <span className="truncate">{modelName}</span>
                        <ChevronRight className="size-3 shrink-0" />
                    </span>
                </button>
                <div className="flex justify-end">
                    {efforts.length > 0 && (
                        <Tooltip content={t('agentChat.model.resetEffort')} side="top">
                            <Button
                                aria-label={t('agentChat.model.resetEffort')}
                                className="text-muted enabled:hover:text-foreground"
                                disabled={!reset}
                                size="icon"
                                variant="ghost"
                                onClick={() => reset && configure({ effort: reset })}
                            >
                                <RotateCcw className="size-4" />
                            </Button>
                        </Tooltip>
                    )}
                </div>
            </div>
            {/* One effort leaves nothing to choose, and a one-stop slider would drag to a stop that does not exist. */}
            {model && efforts.length > 1 && (
                <EffortSlider
                    efforts={efforts}
                    isFast={fast?.isOn === true}
                    stop={dragged ?? agentChatEffortStop(model, effort)}
                    onCommit={(stop) => {
                        setDragged(undefined);
                        const next = efforts[stop];
                        if (next && next !== effort) configure({ effort: next });
                    }}
                    onPreview={setDragged}
                />
            )}
        </div>
    );
}

/**
 * One mode toggle in the header: a muted glyph while off; while on, the glyph in `--foreground` on a pressed fill with
 * a `--border` outline, the treatment the composer's Plan chip uses, so the state reads without color alone and the
 * panel keeps `--accent` for its effort title and slider (DESIGN.md Principle 2). Its tooltip says what it does. The
 * Fast bolt also fills while on, as the Codex app's does; an outline glyph such as ultracode's would fill into blobs.
 */
function ModeButton({
    fillsWhenOn = false,
    icon: Icon,
    label,
    onChange,
    toggle,
}: {
    fillsWhenOn?: boolean;
    icon: ComponentType<{ className?: string }>;
    label: string;
    onChange: (isOn: boolean) => void;
    toggle: AgentChatModeToggle;
}) {
    return (
        <Tooltip
            side="top"
            content={
                <span className="flex flex-col">
                    <span>{label}</span>
                    <span className="text-[11px] leading-4 text-muted">{toggle.description}</span>
                </span>
            }
        >
            <Button
                aria-label={label}
                aria-pressed={toggle.isOn}
                className={
                    toggle.isOn
                        ? 'border-border bg-[var(--selection)] text-foreground'
                        : 'text-muted enabled:hover:text-foreground'
                }
                size="icon"
                variant="ghost"
                onClick={() => onChange(!toggle.isOn)}
            >
                <Icon className={cn('size-4', fillsWhenOn && toggle.isOn && 'fill-current')} />
            </Button>
        </Tooltip>
    );
}

/**
 * The effort slider: a rounded track filled in the accent color up to a round thumb, a dot on every other stop, and
 * twinkles across the fill while Fast mode is on.
 */
function EffortSlider({
    efforts,
    isFast,
    onCommit,
    onPreview,
    stop,
}: {
    efforts: readonly string[];
    isFast: boolean;
    onCommit: (stop: number) => void;
    onPreview: (stop: number) => void;
    stop: number;
}) {
    const { t } = useTranslation();
    const last = efforts.length - 1;
    return (
        <SliderPrimitive.Root
            max={last}
            min={0}
            step={1}
            thumbAlignment="edge"
            value={stop}
            onValueChange={(value) => onPreview(value)}
            onValueCommitted={(value) => onCommit(value)}
        >
            <SliderPrimitive.Control className="relative flex h-7 w-full cursor-pointer touch-none items-center select-none">
                <SliderPrimitive.Track className="relative h-6 w-full overflow-hidden rounded-full bg-foreground/15">
                    <SliderPrimitive.Indicator className="relative overflow-hidden rounded-full bg-accent">
                        {isFast &&
                            SPARKLES.map((sparkle) => (
                                <span
                                    key={sparkle.left}
                                    className="absolute size-1 rounded-full bg-foreground motion-safe:animate-pulse"
                                    style={{
                                        animationDelay: `${sparkle.delay}ms`,
                                        left: `${sparkle.left}%`,
                                        top: `${sparkle.top}%`,
                                    }}
                                />
                            ))}
                    </SliderPrimitive.Indicator>
                </SliderPrimitive.Track>
                {efforts.map((effort, index) =>
                    index === stop || (isFast && index < stop) ? null : (
                        <span
                            key={effort}
                            aria-hidden
                            className={cn(
                                'pointer-events-none absolute size-1 -translate-x-1/2 rounded-full',
                                index < stop ? 'bg-foreground/80' : 'bg-muted',
                            )}
                            style={{
                                left: `calc(${THUMB_RADIUS_PX}px + (100% - ${2 * THUMB_RADIUS_PX}px) * ${index / last})`,
                            }}
                        />
                    ),
                )}
                <SliderPrimitive.Thumb
                    className="size-7 rounded-full bg-foreground shadow-[0_1px_4px_var(--shadow)] outline-none has-focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_50%,transparent)]"
                    getAriaLabel={() => t('agentChat.model.reasoningEffort')}
                    getAriaValueText={(_, value) => agentChatEffortLabel(efforts[value] ?? '', t)}
                />
            </SliderPrimitive.Control>
        </SliderPrimitive.Root>
    );
}
