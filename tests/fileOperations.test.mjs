import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,lstat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createEntry,trashEntry} from '../src/files/FileOperations.ts';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'so-file-operations-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('creation deliberately follows directory links in a selected path or nested name, retaining display paths',async t=>{
 const root=await fixture(t),project=path.join(root,'project'),external=path.join(root,'external');await mkdir(project);await mkdir(external);await symlink(external,path.join(project,'link'));
 const created=await createEntry('file',project,'link/deeper/one.ts',project);assert.equal(created,path.join(project,'link/deeper/one.ts'));assert.equal(await readFile(path.join(external,'deeper/one.ts'),'utf8'),'');
});

test('root aliases preserve exclusive creation and canonical-parent Trash policy without resolving the final link',async t=>{
 const root=await fixture(t),real=path.join(root,'real'),alias=path.join(root,'alias'),outside=path.join(root,'outside');await mkdir(real);await mkdir(outside);await symlink(real,alias);
 const file=await createEntry('file',alias,'one.ts',alias);await assert.rejects(createEntry('file',alias,'one.ts',alias),/already exists/);
 await symlink(path.join(outside,'missing'),path.join(alias,'broken.ts'));await assert.rejects(createEntry('file',alias,'broken.ts',alias),/already exists/);
 const calls=[];await trashEntry('file',path.join(alias,'broken.ts'),alias,async target=>{calls.push(target);});assert.deepEqual(calls,[path.join(alias,'broken.ts')]);assert.equal((await lstat(file)).isFile(),true);
 await symlink(outside,path.join(alias,'escape'));await writeFile(path.join(outside,'one.ts'),'keep');
 await assert.rejects(trashEntry('file',path.join(alias,'escape/one.ts'),alias,async()=>{throw Error('must not call host');}),/parent is outside/);
});

test('a confirmed folder replaced with a symlink is refused before invoking the host',async t=>{
 const root=await fixture(t),folder=path.join(root,'folder'),outside=path.join(root,'outside');await mkdir(folder);await mkdir(outside);await rm(folder,{recursive:true});await symlink(outside,folder);
 let calls=0;await assert.rejects(trashEntry('folder',folder,root,async()=>{calls++;}),/Only folders/);assert.equal(calls,0);
});
