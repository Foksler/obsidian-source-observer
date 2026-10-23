import { Modal, Setting, type App } from 'obsidian';

/** Resolves true only when the user picks the confirming button; closing the dialog cancels. */
export function confirmAction(app: App, title: string, message: string, confirmLabel: string, cancelLabel = 'Cancel'): Promise<boolean> {
	return new Promise((resolve) => {
		let confirmed = false;
		const modal = new Modal(app);
		modal.setTitle(title);
		modal.contentEl.createEl('p', { text: message });
		new Setting(modal.contentEl)
			.addButton((button) => button.setButtonText(cancelLabel).onClick(() => modal.close()))
			.addButton((button) => button.setButtonText(confirmLabel).setWarning().onClick(() => {
				confirmed = true;
				modal.close();
			}));
		modal.onClose = () => resolve(confirmed);
		modal.open();
	});
}
