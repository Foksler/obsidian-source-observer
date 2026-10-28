import assert from 'node:assert/strict';
import test from 'node:test';
import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {moduleViolations} from './helpers/moduleRules.mjs';
const root=path.resolve('src');
async function files(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]))).flat();}
test('production modules use public entry points, keep core independent of hosts/UI, and have no import cycles',async()=>{
 const sources=new Map(await Promise.all((await files(root)).filter(f=>f.endsWith('.ts')).map(async file=>[file,await readFile(file,'utf8')])));
 assert.deepEqual(moduleViolations(root,sources),[]);
});
const fixture=entries=>new Map(Object.entries(entries).map(([file,text])=>[path.join(root,file),text]));
for(const expression of ["import '../ui/index.ts';","void import('../ui/index');","require('../ui/index.js');","import UI = require('../ui/index.ts');","type UI=import('../ui/index.ts').UI;"]){
 test(`the module rule rejects host access through ${expression}`,()=>{
  const errors=moduleViolations(root,fixture({'app/Scenario.ts':expression,'ui/index.ts':'export interface UI{}'}));
  assert.ok(errors.some(error=>error.includes('core depends on ui')),JSON.stringify(errors));
 });
}
test('TS resolution catches extensionless and JS-spelled cycles and deep imports',()=>{
 const errors=moduleViolations(root,fixture({'files/index.ts':"export * from './Scope';",'files/Scope.ts':"import '../git/index.js';",'git/index.ts':"import '../files/Scope.js';"}));
 assert.ok(errors.some(error=>error.includes('cycle:')),JSON.stringify(errors));assert.ok(errors.some(error=>error.includes('deep import')),JSON.stringify(errors));
});
test('host packages, DOM types, browser globals and computed loaders cannot enter app/core',()=>{
 const errors=moduleViolations(root,fixture({'app/Scenario.ts':"import 'obsidian';type View=HTMLElement;globalThis.document;require(runtimeModule);"}));
 for(const category of ['host import','DOM/editor type','browser global','computed module dependency'])assert.ok(errors.some(error=>error.includes(category)),category);
});
