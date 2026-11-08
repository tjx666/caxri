import { executeMobileChatFileScenario } from '../mobile-agent-chat-file-scenario';
import { executeMobileChatImagePendingScenario } from '../mobile-agent-chat-image-pending-scenario';
import {
    executeMobileChatVideoScenario,
    executeMobileChatVideoUnavailableScenario,
} from '../mobile-agent-chat-video-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileComposerAttachmentPreviewScenario } from '../mobile-composer-attachment-preview-scenario';
import { executeMobileComposerVideoCoverScenario } from '../mobile-composer-video-cover-scenario';

export const handlers = {
    'MOB-CHAT-FILE-01': executeMobileChatFileScenario,
    'MOB-CHAT-IMAGE-PENDING-01': executeMobileChatImagePendingScenario,
    'MOB-CHAT-VIDEO-01': executeMobileChatVideoScenario,
    'MOB-CHAT-VIDEO-02': executeMobileChatVideoUnavailableScenario,
    'MOB-COMPOSER-ATTACH-PREVIEW-01': executeMobileComposerAttachmentPreviewScenario,
    'MOB-COMPOSER-VIDEO-COVER-01': executeMobileComposerVideoCoverScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
