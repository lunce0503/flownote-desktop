import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const web='https://flownote-react-staging.vercel.app',api='https://flownote-api-staging.up.railway.app',base='/api/canvas/workspace-folders';
export async function verifySharedFolders(page,token){
 const prior=page.url(),id=randomUUID(),name='Synthetic native shared '+Date.now();let folder;
 const request=async(path,method='GET',data)=>{const r=await fetch(api+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(30000)});assert(r.ok,`Native folder ${method} HTTP ${r.status}`);return r.status===204?null:r.json();};
 const until=async(check,message)=>{for(let i=0;i<100;i++){if(await check())return;await new Promise(r=>setTimeout(r,200));}throw Error(message);};
 try{
  await request('/api/notes','POST',{id,title:name+' note',content:{format:'markdown',version:1,markdown:'Preserve shared native note'},revision:1,client_id:randomUUID()});
  await request('/api/canvas/documents','POST',{id,title:name+' canvas'});
  await page.goto(web+'/canvas');await page.getByRole('button',{name:'새 폴더',exact:true}).click();await page.getByLabel('폴더 이름',{exact:true}).fill(name);await page.getByLabel('폴더 카테고리',{exact:true}).fill('Native course');
  const created=page.waitForResponse(r=>r.url().endsWith(base)&&r.request().method()==='POST');await page.getByRole('button',{name:'폴더 만들기',exact:true}).click();const response=await created;assert(response.ok());folder=await response.json();
  const toggle=page.getByRole('button',{name:'탐색기 토글',exact:true});if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await page.getByRole('button',{name:'모든 파일',exact:true}).click();
  await page.getByLabel(name+' note 이동',{exact:true}).selectOption('shared:'+folder.id);await until(async()=>(await request(base+'/'+folder.id)).note_ids.includes(id),'Native note membership');
  await page.getByLabel(name+' canvas 이동',{exact:true}).selectOption('shared:'+folder.id);await until(async()=>(await request(base+'/'+folder.id)).canvas_ids.includes(id),'Native canvas membership');
  await page.reload();if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await page.locator(`[data-folder="shared:${folder.id}"]`).click();const table=page.getByRole('table',{name:name+' 파일'});await table.getByRole('button',{name:name+' note',exact:true}).waitFor();await table.getByRole('button',{name:name+' canvas',exact:true}).waitFor();
  await table.getByRole('button',{name:name+' note',exact:true}).click();await page.getByRole('textbox',{name:'노트 편집',exact:true}).waitFor();if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
  await page.getByLabel(name+' 폴더 동작',{exact:true}).click();await page.getByRole('button',{name:'이름·카테고리 변경',exact:true}).click();await page.getByLabel('폴더 카테고리',{exact:true}).fill('Native revised course');await page.getByRole('button',{name:'폴더 저장',exact:true}).click();await until(async()=>(await request(base+'/'+folder.id)).category==='Native revised course','Native category persistence');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  folder=await request(base+'/'+folder.id);await request(base+'/'+folder.id,'DELETE',{revision:folder.revision});folder=undefined;
  assert.equal((await request('/api/notes/'+id)).content.markdown,'Preserve shared native note');assert((await request('/api/canvas/documents')).some(c=>c.id===id));
  console.log('PASS native shared folders: mixed kinds, persistent move/reload, note-detail category editing, folder delete preserves both originals');
 }finally{
  if(folder){const f=await request(base+'/'+folder.id);await request(base+'/'+folder.id,'DELETE',{revision:f.revision});}
  for(const path of ['/api/notes/','/api/canvas/documents/']){const r=await fetch(api+path+id,{method:'DELETE',headers:{Authorization:'Bearer '+token}});assert([200,204,404].includes(r.status),'Native shared synthetic cleanup');}
  await page.goto(prior);
 }
}
