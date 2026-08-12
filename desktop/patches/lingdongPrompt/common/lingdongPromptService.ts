/*---------------------------------------------------------------------------------------------
 * 灵动 Prompt 宿主服务骨架。内置 Agent / 后续 Prompt UI 只应依赖此接口，
 * 而不是在扩展里再造一套「伪系统 API」。
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const ILingdongPromptService = createDecorator<ILingdongPromptService>('lingdongPromptService');

export interface ILingdongPromptService {
	readonly _serviceBrand: undefined;
	/** 骨架状态文案；后续替换为真实会话/鉴权桥。 */
	getStatusMessage(): string;
}

export class LingdongPromptService implements ILingdongPromptService {
	declare readonly _serviceBrand: undefined;

	getStatusMessage(): string {
		return '灵动 Prompt 宿主 API 骨架已加载（Workbench 一等贡献）。协议对齐后在此扩展。';
	}
}
