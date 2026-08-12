/*---------------------------------------------------------------------------------------------
 * 灵动 Prompt · Workbench 一等贡献（骨架）
 * 后续在此注册服务、面板与和内置 Agent 的桥接；禁止再做成可卸载 VSIX。
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILocalizedString, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILingdongPromptService, LingdongPromptService } from '../common/lingdongPromptService.js';

registerSingleton(ILingdongPromptService, LingdongPromptService, InstantiationType.Delayed);

class LingdongPromptContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.lingdongPrompt';

	constructor(
		@ILingdongPromptService private readonly promptService: ILingdongPromptService,
	) {
		super();
		// 触达一次服务，确保单例初始化。
		void this.promptService;
	}
}

registerWorkbenchContribution2(LingdongPromptContribution.ID, LingdongPromptContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'lingdong.prompt.open',
			title: localize2('lingdongPrompt.open', 'Lingdong Prompt: Open (Stub)'),
			category: Categories.View,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		const prompts = accessor.get(ILingdongPromptService);
		const notification = accessor.get(INotificationService);
		notification.notify({
			severity: Severity.Info,
			message: prompts.getStatusMessage(),
		});
	}
});

/*
 * 菜单栏入口。
 *
 * 顶层菜单不是扩展能碰的贡献点——`contributes.menus` 没有 menubar 这个位置，
 * 所以灵动自己的入口只能在这里以工作台一等公民的身份注册，动作体再转发到扩展命令。
 * 扩展是 onStartupFinished 常驻的，转发不会落空。
 *
 * 命令 ID 用的是扩展那边的 `lingdongAgent.*`。那批 ID 是用户设置和键位绑定的锚点，
 * 不随显示名改动，所以这里写死是安全的。
 */

interface MenuEntry {
	/** 本 action 自己的 ID，不要和扩展命令 ID 撞。 */
	id: string;
	/**
	 * 必须在这张表里就地调 localize2，且两个参数都写成字面量。
	 *
	 * 构建期的 build/lib/nls.js 会静态扫描 localize/localize2 调用来生成翻译表，
	 * 它拿到的是参数在源码里的原文并直接 eval。传变量（哪怕值是常量字符串）会让
	 * 它 eval 到一个不存在的标识符，报 "xxx is not defined"。
	 * 这个错误发生在整条流水线的最末端，编译一小时后才炸，所以别图省事。
	 */
	title: ILocalizedString;
	/** 转发到扩展贡献的命令。 */
	command: string;
	menu: MenuId;
	group: string;
	order: number;
}

const MENU_ENTRIES: readonly MenuEntry[] = [
	// 文件 > 首选项：对齐 VS Code 把设置类入口收在这里的习惯。
	// 设置只有一页，所以这里也只留一个入口——三条并列会让人以为它们是三个地方。
	{
		id: 'lingdong.menu.settings',
		title: localize2('lingdong.menu.settings', '灵动 Code 设置'),
		command: 'lingdongAgent.openSettings',
		menu: MenuId.MenubarPreferencesMenu,
		group: '2_configuration',
		order: 10,
	},
	{
		id: 'lingdong.menu.providerKey',
		title: localize2('lingdong.menu.providerKey', '灵动 Code 服务商密钥'),
		command: 'lingdongAgent.configureProviderKey',
		menu: MenuId.MenubarPreferencesMenu,
		group: '2_configuration',
		order: 11,
	},
	// 查看：打开主面板和新建对话属于导航，放在这里。
	{
		id: 'lingdong.menu.openPanel',
		title: localize2('lingdong.menu.openPanel', '灵动 Code 面板'),
		command: 'lingdongAgent.open',
		menu: MenuId.MenubarViewMenu,
		group: '3_workbench',
		order: 10,
	},
	{
		id: 'lingdong.menu.newSession',
		title: localize2('lingdong.menu.newSession', '新建对话'),
		command: 'lingdongAgent.newSession',
		menu: MenuId.MenubarViewMenu,
		group: '3_workbench',
		order: 11,
	},
	// 帮助：诊断类。隐私状态放这里是因为用户找它通常是在「这东西把我的数据传哪去了」的语境下。
	{
		id: 'lingdong.menu.privacy',
		title: localize2('lingdong.menu.privacy', '灵动 Code 隐私状态'),
		command: 'lingdongAgent.showPrivacyStatus',
		menu: MenuId.MenubarHelpMenu,
		group: '1_welcome',
		order: 20,
	},
	{
		id: 'lingdong.menu.logs',
		title: localize2('lingdong.menu.logs', '灵动 Code 日志'),
		command: 'lingdongAgent.showLogs',
		menu: MenuId.MenubarHelpMenu,
		group: '1_welcome',
		order: 21,
	},
];

for (const entry of MENU_ENTRIES) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: entry.id,
				title: entry.title,
				// 命令面板里扩展已经贡献过同名命令，这里再冒一个就是两条一模一样的。
				f1: false,
				menu: [{ id: entry.menu, group: entry.group, order: entry.order }],
			});
		}

		run(accessor: ServicesAccessor): Promise<unknown> {
			return accessor.get(ICommandService).executeCommand(entry.command);
		}
	});
}
