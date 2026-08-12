import type { PlanEditPayload } from "../../messages";
import {
  collectPlanPayloadFromDocument,
  renderPlanDocumentView,
  type PlanDocumentActions,
} from "./plan-document-view";
import { synthesizePlanMarkdown } from "./plan-synthesize";
import type { PlanDocumentViewModel } from "./plan-view-model";

export { synthesizePlanMarkdown };

/**
 * 兼容旧入口名：编辑即文档 WYSIWYG，不再切换到 textarea 源码框。
 */
export interface PlanMarkdownEditorActions {
  onSave: (payload: PlanEditPayload) => void;
  onDiscard: () => void;
  onStartBuild: () => void;
  onOpenFile: (relativePath: string) => void;
  onCancelEdit?: () => void;
  onOpenLink?: (href: string) => void;
}

export function renderPlanMarkdownEditor(
  model: PlanDocumentViewModel,
  actions: PlanMarkdownEditorActions,
): HTMLElement {
  const docActions: PlanDocumentActions = {
    onSave: actions.onSave,
    onDiscard: actions.onDiscard,
    onStartBuild: actions.onStartBuild,
    onOpenFile: actions.onOpenFile,
    ...(actions.onOpenLink ? { onOpenLink: actions.onOpenLink } : {}),
  };
  return renderPlanDocumentView(model, docActions);
}

export function collectPlanPayloadFromRoot(root: HTMLElement): PlanEditPayload | undefined {
  return collectPlanPayloadFromDocument(root);
}
