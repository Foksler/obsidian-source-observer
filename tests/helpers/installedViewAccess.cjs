// Compatibility belongs to the measurement harness, not production view state.
module.exports=function(view){
 if(!view?.workspaceSession)return view;
 const aliases={repoPath:'activeFolder',folderPaths:'folders',folderSessions:'sessions',previewFiles:'previews',recentFiles:'recents',folderRequestId:'folderGeneration',diffRequestId:'contentGeneration'};
 return new Proxy(view,{
  get(target,key){if(aliases[key])return target.workspaceSession[aliases[key]];if(key==='watchers')return target.observation?.watchers??[];const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;},
  set(target,key,value){if(aliases[key]){target.workspaceSession[aliases[key]]=value;return true;}return Reflect.set(target,key,value,target);}
 });
};
