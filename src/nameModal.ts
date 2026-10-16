import { Modal, Setting, type App } from 'obsidian';

/**
 * Asks for a name and hands it to `submit`, which returns an error or null once it succeeded.
 * An error keeps the dialog open so the name can be corrected. Resolves true after a successful
 * submit; closing the dialog cancels.
 */
export function promptForName(app: App, title: string, location: string, confirmLabel: string,
	submit: (name: string) => Promise<string | null>): Promise<boolean> {
	return new Promise((resolve) => {
		let done = false, busy = false;
		const modal = new Modal(app);
		modal.modalEl.addClass('so-name-modal');
		modal.setTitle(title);
		modal.contentEl.createEl('p', { cls: 'so-name-location', text: location });
		const input = modal.contentEl.createEl('input', { type: 'text', cls: 'so-name-input', attr: { 'aria-label': 'Name', spellcheck: 'false' } });
		const error = modal.contentEl.createDiv({ cls: 'so-name-error', attr: { role: 'alert' } });
		error.hidden = true;
		const confirm = async () => {
			if (busy) return;
			busy = true;
			const message = await submit(input.value);
			busy = false;
			if (message === null) { done = true; modal.close(); return; }
			error.setText(message);
			error.hidden = false;
			input.focus();
		};
		input.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter' || event.isComposing) return;
			event.preventDefault();
			void confirm();
		});
		input.addEventListener('input', () => { error.hidden = true; });
		new Setting(modal.contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => modal.close()))
			.addButton((button) => button.setButtonText(confirmLabel).setCta().onClick(() => { void confirm(); }));
		modal.onClose = () => resolve(done);
		modal.open();
		input.focus();
	});
}
