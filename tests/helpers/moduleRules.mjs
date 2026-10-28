import path from 'node:path';
import ts from 'typescript';
const core=new Set(['app','workspace','documents','files','git','search','language']);
const hostModules=new Set(['ui','obsidian','desktop']);
const forbiddenTypes=new Set(['HTMLElement','SVGElement','Document','Window','Element','Node','Event','KeyboardEvent','MouseEvent','EditorView','EditorState']);
/** Analyze actual TS module resolution, including type dependencies and literal runtime loaders. */
export function moduleViolations(root,sources){
 const graph=new Map(),errors=[];
 const host={fileExists:file=>sources.has(path.resolve(file)),readFile:file=>sources.get(path.resolve(file)),directoryExists:dir=>[...sources.keys()].some(file=>file.startsWith(path.resolve(dir)+path.sep)),getCurrentDirectory:()=>root,realpath:file=>path.resolve(file)};
 const moduleOf=file=>path.relative(root,file).split(path.sep)[0];
 for(const [file,text]of sources){
  const module=moduleOf(file),ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),edges=[];graph.set(file,edges);
  const error=message=>errors.push(`${path.relative(root,file)}: ${message}`);
  function dependency(spec){
   if((core.has(module)||module==='desktop')&&/^(obsidian|electron|@codemirror\/|@lezer\/)/.test(spec))error(`host import ${spec}`);
   if(!spec.startsWith('.'))return;
   const target=ts.resolveModuleName(spec,file,{moduleResolution:ts.ModuleResolutionKind.Node10,allowImportingTsExtensions:true},host).resolvedModule?.resolvedFileName;
   if(!target){error(`unresolved import ${spec}`);return;}
   const other=moduleOf(target);edges.push(target);
   if(path.dirname(file)!==root&&module!==other&&path.basename(target)!=='index.ts')error(`deep import ${spec}`);
   if(core.has(module)&&hostModules.has(other))error(`core depends on ${other}`);
   if(module==='desktop'&&['ui','obsidian'].includes(other))error(`desktop depends on ${other}`);
   if(other==='main.ts')error('composition root imported');
  }
  function literal(node){if(node&&ts.isStringLiteralLike(node))dependency(node.text);else error('computed module dependency is not allowed');}
  function visit(node){
   if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)literal(node.moduleSpecifier);
   if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference))literal(node.moduleReference.expression);
   if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument))literal(node.argument.literal);
   if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require'))literal(node.arguments[0]);
   if(core.has(module)&&ts.isTypeReferenceNode(node)&&(/^(HTML|SVG).+Element$/.test(node.typeName.getText(ast))||forbiddenTypes.has(node.typeName.getText(ast))))error(`DOM/editor type ${node.typeName.getText(ast)}`);
   if(core.has(module)&&ts.isPropertyAccessExpression(node)){
    const owner=node.expression.getText(ast),member=node.name.text;
    if(owner==='window'||owner==='globalThis'&&['window','document'].includes(member)||owner==='document'&&['createElement','body','querySelector','addEventListener','defaultView'].includes(member))error(`browser global ${node.getText(ast)}`);
   }
   if(core.has(module)&&ts.isElementAccessExpression(node)&&['globalThis','window'].includes(node.expression.getText(ast)))error(`computed browser access ${node.getText(ast)}`);
   ts.forEachChild(node,visit);
  }visit(ast);
 }
 const active=new Set(),done=new Set();
 function walk(file,trail){if(active.has(file)){errors.push(`cycle: ${[...trail,file].map(f=>path.relative(root,f)).join(' -> ')}`);return;}if(done.has(file))return;active.add(file);for(const next of graph.get(file)??[])walk(next,[...trail,file]);active.delete(file);done.add(file);}
 for(const file of graph.keys())walk(file,[]);
 return errors;
}
