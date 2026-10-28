import { DocumentSession, type DocumentIO, type DocumentRecovery, type DocumentHandlers } from './DocumentSession.ts';

/** Shared document ownership: detached clean entries leave the store; unresolved buffers stay. */
export class DocumentStore {
	private documents = new Map<string, DocumentSession>();
	private opening = new Map<string, number>();
	private generations = new Map<string, number>();
	private io: DocumentIO;
	private stopped = false;
	private fallback: DocumentHandlers;
 private recoveryChanged:()=>void;
 private observers = new Map<DocumentSession,()=>void>();
 private bindings = new Map<DocumentSession,Map<symbol,DocumentHandlers>>();
 private watch(document: DocumentSession) {
  document.setHandlers(this.fallback);
  let hadRecovery=document.recovery()!==null;
  this.observers.set(document,document.subscribe(()=>{
   const hasRecovery=document.recovery()!==null;
   this.cleanDetached(document);
   if(hadRecovery&&!hasRecovery)this.recoveryChanged();
   hadRecovery=hasRecovery;
  }));
 }
 private unwatch(document: DocumentSession) { this.observers.get(document)?.();this.observers.delete(document);this.bindings.get(document)?.clear();this.bindings.delete(document); }
 private cleanDetached(document: DocumentSession) {
  if(this.stopped || this.leases.has(document) || document.hasPendingSave || document.snapshot().dirty || this.documents.get(document.path)!==document)return;
  this.unwatch(document);this.documents.delete(document.path);document.stop();
 }
 /** A renderer owns its handler binding, independently of other live renderer leases. */
 bindHandlers(document: DocumentSession, handlers: DocumentHandlers):()=>void {
  if(this.stopped || this.documents.get(document.path)!==document)return ()=>{};
  let bindings=this.bindings.get(document);if(!bindings){bindings=new Map();this.bindings.set(document,bindings);}
  const token=Symbol();bindings.set(token,handlers);document.setHandlers(handlers);
  return ()=>{
   if(!bindings.delete(token))return;
   if(!bindings.size)this.bindings.delete(document);
   if(!this.stopped&&this.documents.get(document.path)===document)document.setHandlers([...bindings.values()].slice(-1)[0]??this.fallback);
  };
 }
 private leases = new Map<DocumentSession, number>();
	private retain(document: DocumentSession) {
		this.leases.set(document, (this.leases.get(document) ?? 0) + 1); return document;
	}
	constructor(io: DocumentIO, fallback: DocumentHandlers = {saved(){},failed(){},conflict:()=>Promise.resolve('cancel')},recoveryChanged:()=>void=()=>{}) { this.io = io;this.fallback=fallback;this.recoveryChanged=recoveryChanged; }
	async open(filePath: string): Promise<DocumentSession | null> {
		if (this.stopped) return null;
		let document = this.documents.get(filePath);
		if (document) {
            this.retain(document);
            try { await document.reloadIfChanged(); }
            catch(error){this.release(document);throw error;}
            if(!this.stopped&&this.documents.get(filePath)===document)return document;
            this.release(document);return null;
		}
		const generation = this.generations.get(filePath) ?? 0;
		this.opening.set(filePath, (this.opening.get(filePath) ?? 0) + 1);
		let file;
		try { file = await this.io.read(filePath); }
		finally {
			const count = this.opening.get(filePath)! - 1;
			if (count) this.opening.set(filePath, count); else this.opening.delete(filePath);
		}
		if (this.stopped || (this.generations.get(filePath) ?? 0) !== generation) return null;
		// Concurrent opens converge on one identity.
		document = this.documents.get(filePath);
		if (document) return this.retain(document);
		document = new DocumentSession(filePath, file, this.io); this.documents.set(filePath, document); this.watch(document);
		return this.retain(document);
	}
	forget(matches: (filePath: string) => boolean) {
 const hadRecovery=this.recoveries().some(document=>matches(document.path));
		for (const filePath of new Set([...this.documents.keys(), ...this.opening.keys()])) if (matches(filePath)) {
			this.generations.set(filePath, (this.generations.get(filePath) ?? 0) + 1);
			const document=this.documents.get(filePath);if(document){this.unwatch(document);document.setHandlers(this.fallback);document.revoke();} this.documents.delete(filePath);
		}
 if(hadRecovery)this.recoveryChanged();
	}
 release(document: DocumentSession) {
  const current=this.leases.get(document);if(current===undefined)return;
  const remaining=current-1;
  if(remaining>0){this.leases.set(document,remaining);return;}
  this.leases.delete(document);this.bindings.get(document)?.clear();this.bindings.delete(document);document.setHandlers(this.fallback);this.cleanDetached(document);
 }

	recoveries(): DocumentRecovery[] { return [...this.documents.values()].flatMap(document => document.recovery() ?? []); }
	restore(recoveries: DocumentRecovery[]) {
		for (const recovery of recoveries) {
			const previous=this.documents.get(recovery.path);if(previous){this.unwatch(previous);previous.stop();this.leases.delete(previous);}
			const document = new DocumentSession(recovery.path, { content: recovery.baseline, editable: true }, this.io);
			document.restore(recovery); this.documents.set(recovery.path, document);this.watch(document);
		}
	}
	stop() { this.stopped = true; for (const document of this.documents.values()){this.unwatch(document);document.stop();}this.leases.clear(); }
}
