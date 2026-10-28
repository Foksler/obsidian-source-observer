import { Notice } from 'obsidian';
import * as path from 'path';
import type { LanguageEvent } from '../language/index.ts';
/** Host presentation of plugin-owned server events. */
export class LanguageNotices {
    private indexing = new Map<string, Notice>();
    handle(event: LanguageEvent) {
        const key = event.key;
        if (event.type === 'message') {
            if (event.message)
                new Notice(`Source Observer: ${event.message}`);
            return;
        }
        if (event.type === 'indexing') {
            this.indexing.get(key)?.hide();
            this.indexing.delete(key);
            if (event.active)
                this.indexing.set(key, new Notice(`Indexing ${event.name} in ${path.basename(event.root)}…`, 0));
        }
        else
            new Notice(`Source Observer: ${event.name} in ${path.basename(event.root)}: ${event.error?.message ?? 'Server unavailable'}`);
    }
    dispose() {
        for (const notice of this.indexing.values())
            notice.hide();
        this.indexing.clear();
    }
}
