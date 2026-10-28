import { Modal, Setting, type App } from 'obsidian';
import type { ConflictDecision } from '../documents/index.ts';

/** Closing a save-conflict dialog cancels the transition; discarding edits is explicit. */
export function chooseDocumentConflict(app: App, filePath: string, missing: boolean): Promise<ConflictDecision> {
	return new Promise(resolve => {
		let decision: ConflictDecision = 'cancel';
		const modal = new Modal(app);
		modal.setTitle(missing ? 'File was removed' : 'File changed on disk');
		modal.contentEl.createEl('p', { text: `${filePath} ${missing ? 'no longer exists' : 'changed after it was opened'}. Choose what to do with your edits.` });
		new Setting(modal.contentEl)
			.addButton(button => button.setButtonText('Cancel').onClick(() => modal.close()))
			.addButton(button => button.setButtonText(missing ? 'Discard edits' : 'Load from disk').onClick(() => { decision = 'discard'; modal.close(); }))
			.addButton(button => button.setButtonText(missing ? 'Recreate' : 'Overwrite').setWarning().onClick(() => { decision = 'overwrite'; modal.close(); }));
		modal.onClose = () => resolve(decision);
		modal.open();
	});
}

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
