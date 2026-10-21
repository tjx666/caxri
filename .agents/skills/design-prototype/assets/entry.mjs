/**
 * Single source of truth for what the design-prototype runtime bundles. Every key is a module specifier a prototype may
 * `import` from; the value is the module namespace the template's `window.require` shim hands back. Missing a module in
 * a prototype → add it here and rerun `scripts/build-runtime.ts` (~2s).
 *
 * Bundled from THIS repo's node_modules and Renderer source, so prototypes render with the exact production primitives,
 * tokens, and versions.
 */
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';

import * as cva from 'class-variance-authority';
import * as clsx from 'clsx';
import * as cmdk from 'cmdk';
import * as lucideReact from 'lucide-react';
import * as motionReact from 'motion/react';
import * as tailwindMerge from 'tailwind-merge';
import * as zustand from 'zustand';

import * as ShortcutBadge from '@/components/shortcut-badge';
import * as Alert from '@/components/ui/alert';
import * as Button from '@/components/ui/button';
import * as Checkbox from '@/components/ui/checkbox';
import * as Command from '@/components/ui/command';
import * as Dialog from '@/components/ui/dialog';
import * as Empty from '@/components/ui/empty';
import * as Field from '@/components/ui/field';
import * as HoverCard from '@/components/ui/hover-card';
import * as Input from '@/components/ui/input';
import * as Kbd from '@/components/ui/kbd';
import * as Label from '@/components/ui/label';
import * as Menu from '@/components/ui/menu';
import * as Popover from '@/components/ui/popover';
import * as Progress from '@/components/ui/progress';
import * as Select from '@/components/ui/select';
import * as Separator from '@/components/ui/separator';
import * as Skeleton from '@/components/ui/skeleton';
import * as Spinner from '@/components/ui/spinner';
import * as SplitButton from '@/components/ui/split-button';
import * as Switch from '@/components/ui/switch';
import * as Textarea from '@/components/ui/textarea';
import * as ToastOutlet from '@/features/toasts/toast-outlet';
import * as Toasts from '@/stores/toasts';
import * as Toggle from '@/components/ui/toggle';
import * as ToggleGroup from '@/components/ui/toggle-group';
import * as Tooltip from '@/components/ui/tooltip';
import * as useChartKeyboardCursor from '@/hooks/use-chart-keyboard-cursor';
import * as useContainerWidth from '@/hooks/use-container-width';
import * as useContextMenu from '@/hooks/use-context-menu';
import * as useDebouncedValue from '@/hooks/use-debounced-value';
import * as useEditorOptions from '@/hooks/use-editor-options';
import * as useFocusOnRevision from '@/hooks/use-focus-on-revision';
import * as useIsOverflowing from '@/hooks/use-is-overflowing';
import * as useLatestReference from '@/hooks/use-latest-reference';
import * as useModalRegistration from '@/hooks/use-modal-registration';
import * as useOnVisible from '@/hooks/use-on-visible';
import * as usePointerDragResize from '@/hooks/use-pointer-drag-resize';
import * as usePolledQuery from '@/hooks/use-polled-query';
import * as useRelativeTime from '@/hooks/use-relative-time';
import * as useResourceLoad from '@/hooks/use-resource-load';
import * as useScrollEdge from '@/hooks/use-scroll-edge';
import * as useScrollEdges from '@/hooks/use-scroll-edges';
import * as useSessionExcerpts from '@/hooks/use-session-excerpts';
import * as useShouldReduceMotion from '@/hooks/use-should-reduce-motion';
import * as useStartupLoaderRemoval from '@/hooks/use-startup-loader-removal';
import * as useWorkbenchAppearance from '@/hooks/use-workbench-appearance';
import * as motionLib from '@/lib/motion';
import * as utilities from '@/lib/utilities';

export default {
    'react': React,
    'react-dom': ReactDOM,
    'react-dom/client': ReactDOMClient,
    'lucide-react': lucideReact,
    'motion/react': motionReact,
    'class-variance-authority': cva,
    'clsx': clsx,
    'cmdk': cmdk,
    'tailwind-merge': tailwindMerge,
    'zustand': zustand,
    '@/lib/utilities': utilities,
    '@/lib/motion': motionLib,
    '@/components/shortcut-badge': ShortcutBadge,
    '@/components/ui/alert': Alert,
    '@/components/ui/button': Button,
    '@/components/ui/checkbox': Checkbox,
    '@/components/ui/command': Command,
    '@/components/ui/dialog': Dialog,
    '@/components/ui/empty': Empty,
    '@/components/ui/field': Field,
    '@/components/ui/hover-card': HoverCard,
    '@/components/ui/input': Input,
    '@/components/ui/kbd': Kbd,
    '@/components/ui/label': Label,
    '@/components/ui/menu': Menu,
    '@/components/ui/popover': Popover,
    '@/components/ui/progress': Progress,
    '@/components/ui/select': Select,
    '@/components/ui/separator': Separator,
    '@/components/ui/skeleton': Skeleton,
    '@/components/ui/spinner': Spinner,
    '@/components/ui/split-button': SplitButton,
    '@/components/ui/switch': Switch,
    '@/components/ui/textarea': Textarea,
    '@/features/toasts/toast-outlet': ToastOutlet,
    '@/stores/toasts': Toasts,
    '@/components/ui/toggle': Toggle,
    '@/components/ui/toggle-group': ToggleGroup,
    '@/components/ui/tooltip': Tooltip,
    '@/hooks/use-chart-keyboard-cursor': useChartKeyboardCursor,
    '@/hooks/use-container-width': useContainerWidth,
    '@/hooks/use-context-menu': useContextMenu,
    '@/hooks/use-debounced-value': useDebouncedValue,
    '@/hooks/use-editor-options': useEditorOptions,
    '@/hooks/use-focus-on-revision': useFocusOnRevision,
    '@/hooks/use-is-overflowing': useIsOverflowing,
    '@/hooks/use-latest-reference': useLatestReference,
    '@/hooks/use-modal-registration': useModalRegistration,
    '@/hooks/use-on-visible': useOnVisible,
    '@/hooks/use-pointer-drag-resize': usePointerDragResize,
    '@/hooks/use-polled-query': usePolledQuery,
    '@/hooks/use-relative-time': useRelativeTime,
    '@/hooks/use-resource-load': useResourceLoad,
    '@/hooks/use-scroll-edge': useScrollEdge,
    '@/hooks/use-scroll-edges': useScrollEdges,
    '@/hooks/use-session-excerpts': useSessionExcerpts,
    '@/hooks/use-should-reduce-motion': useShouldReduceMotion,
    '@/hooks/use-startup-loader-removal': useStartupLoaderRemoval,
    '@/hooks/use-workbench-appearance': useWorkbenchAppearance,
};
