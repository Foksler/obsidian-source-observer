import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,symlink,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileScope,FILE_POLICY_PROFILES,GO_INDEX_EXCLUDED_DIRECTORIES } from '../src/files/FileScope.ts';
const options={showHidden:true,includeWorktrees:false,excludedFiles:[],worktreeRoots:[]};

test('named file profiles preserve intentionally different coverage',()=>{
 const scope=new FileScope('/project',options);
 assert.equal(scope.allows('tree','.git/HEAD'),true);assert.equal(scope.allows('filename','.git/HEAD'),false);
 assert.equal(scope.allows('filename','vendor/library.php'),true);assert.equal(scope.allows('content','vendor/library.php'),false);assert.equal(scope.allows('languageRoots','vendor/library.php'),false);
 assert.equal(scope.allows('filename','package-lock.json'),true);assert.equal(scope.allows('content','package-lock.json'),false);
 assert.equal(FILE_POLICY_PROFILES.content.ignoreFiles,true);assert.equal(FILE_POLICY_PROFILES.filename.ignoreFiles,false);
 assert.equal(GO_INDEX_EXCLUDED_DIRECTORIES.includes('vendor'),false);
});

test('tree expands links lazily while search and language discovery skip them',()=>{
 const scope=new FileScope('/project',options);
 assert.equal(scope.allows('tree','alias',true),true);
 for(const profile of ['filename','content','languageRoots'])assert.equal(scope.allows(profile,'alias',true),false);
});

test('filename inventory retains hidden paths independently of tree/query visibility',()=>{
 const scope=new FileScope('/project',{...options,showHidden:false});
 assert.equal(scope.allows('tree','.env'),false);assert.equal(scope.allows('content','.env'),false);assert.equal(scope.allows('filename','.env'),true);
 assert.equal(scope.allows('filename','.obsidian/config.json'),false);
});

test('policy snapshots retain their exclusions and registered worktrees after caller mutation',()=>{
 const excluded=['private/**'],trees=['/project/linked'];const scope=new FileScope('/project',{...options,excludedFiles:excluded,worktreeRoots:trees,revision:4});
 excluded.length=0;trees.length=0;
 assert.equal(scope.allows('tree','private/note.md'),false);assert.equal(scope.allows('filename','linked/new.ts'),false);assert.equal(scope.allows('content','worktrees/branch/new.ts'),false);assert.equal(scope.revision,4);
 assert.equal(scope.allows('filename','../other/file.ts'),false);assert.equal(scope.allows('filename','normal.ts'),true);
});

test('display root aliases remain separate from canonical containment and sibling prefixes',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'so-scope-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const project=path.join(root,'project'),outside=path.join(root,'project-other'),alias=path.join(root,'alias');await mkdir(project);await mkdir(outside);await symlink(project,alias);await symlink(outside,path.join(project,'external'));
 const scope=new FileScope(alias,options);assert.equal(scope.root.display,alias);assert.notEqual(scope.root.canonical,alias);
 assert.equal(scope.containsCanonical(path.join(alias,'new.ts')),true);assert.equal(scope.containsCanonical(path.join(alias,'external')),false);assert.equal(scope.containsCanonical(outside),false);
});

test('relative traversal is normalized without treating Unix backslashes as directory separators',()=>{
 const scope=new FileScope('/project',options);assert.equal(scope.allows('tree','folder/../../outside.ts'),false);
 if(path.sep==='/')assert.equal(scope.allows('filename','folder\\worktrees\\literal.ts'),true);
});
