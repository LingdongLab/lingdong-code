/**
 * 旧表单编辑器已退役。计划正文在渲染态直接编辑（WYSIWYG）。
 * 此文件仅做兼容再导出，避免外部旧 import 断裂。
 */
export {
  collectPlanPayloadFromRoot,
  renderPlanMarkdownEditor as renderPlanEditorView,
  synthesizePlanMarkdown,
} from "./plan-markdown-editor";
