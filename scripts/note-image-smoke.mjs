import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const web='https://flownote-react-staging.vercel.app',api='https://flownote-api-staging.up.railway.app';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const src='data:image/png;base64,'+png;
// HTML file-input/CDP payloads and File clipboard/drop events exercise the real
// packaged renderer/decoder. They do not certify the operating-system chooser.
export async function verifyNoteImages(page,token){
  const id=randomUUID(),prior=page.url(),original='Synthetic native image before\n\nPreserve after';
  const request=async(path,method='GET',data)=>{const r=await fetch(api+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(30000)});assert(r.ok,`Native image ${method} HTTP ${r.status}`);return r.status===204?null:r.json();};
  const images=()=>page.getByTestId('markdown-live-editor').locator('img');
  const ready=async count=>{
    try {
      await page.waitForFunction(count=>{const nodes=[...document.querySelectorAll('[data-testid="markdown-live-editor"] img')];return nodes.length===count&&nodes.every(n=>n.complete&&n.naturalWidth===1&&n.naturalHeight===1);},count);
    } catch (error) {
      const state=await page.evaluate(()=>({
        images:[...document.querySelectorAll('[data-testid="markdown-live-editor"] img')].map(n=>({complete:n.complete,width:n.naturalWidth,height:n.naturalHeight})),
        selectedImages:document.querySelectorAll('.ProseMirror-selectednode').length,
        activeTag:document.activeElement?.tagName,
        anchorOffset:getSelection()?.anchorOffset,focusOffset:getSelection()?.focusOffset,
        saveStatus:document.querySelector('[data-testid="note-save-status"]')?.textContent,
      }));
      const stored=await request('/api/notes/'+id);
      throw new Error(`Native image ready expected=${count} state=${JSON.stringify(state)} storedImages=${(stored.content?.markdown?.match(/data:image\/png;base64,/g)||[]).length}`,{cause:error});
    }
    assert.equal(await images().count(),count);
  };
  const transfer=async kind=>page.getByRole('textbox',{name:'노트 편집',exact:true}).evaluate((node,{kind,png})=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],'native-paste.png',{type:'image/png'}));const r=node.getBoundingClientRect();node.dispatchEvent(kind==='paste'?new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}):new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true,clientX:r.x+8,clientY:r.y+8}));},{kind,png});
  const appendCaret=async()=>{
    const editor=page.getByRole('textbox',{name:'노트 편집',exact:true});
    await editor.press('ControlOrMeta+End'); await editor.press('ArrowRight');
    await page.waitForFunction(()=>{
      const editor=document.querySelector('[role="textbox"][aria-label="노트 편집"]');
      const selection=getSelection();
      return editor?.contains(selection?.anchorNode)&&selection.isCollapsed&&!editor.querySelector('.ProseMirror-selectednode');
    });
  };
  let created=false;
  try{
    await request('/api/notes','POST',{id,title:'Synthetic native image',content:{format:'markdown',version:1,markdown:original},revision:1,client_id:randomUUID()});created=true;
    await page.goto(web+'/blog/'+id);const editor=page.getByRole('textbox',{name:'노트 편집',exact:true});await editor.waitFor();assert((await editor.textContent()).includes('Preserve after'));
    await page.getByRole('button',{name:'편집 도구',exact:true}).click();await editor.press('ControlOrMeta+End');await editor.press('Enter');
    await page.getByLabel('노트 이미지 파일',{exact:true}).setInputFiles({name:'native [image].png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await ready(1);
    await appendCaret();await transfer('paste');await ready(2);
    const ack=page.waitForResponse(r=>{if(r.request().method()!=='POST'||!r.url().endsWith('/api/notes'))return false;const b=r.request().postDataJSON();return b?.id===id&&(b.content?.markdown?.match(/data:image\/png;base64,/g)||[]).length===3;});
    await appendCaret();await transfer('drop');await ready(3);assert((await ack).ok(),'Native image save must receive a successful server ACK');
    const stored=(await request('/api/notes/'+id)).content.markdown;assert.equal((stored.match(/data:image\/png;base64,/g)||[]).length,3);assert(stored.includes(src)&&stored.includes('Synthetic native image before')&&stored.includes('Preserve after'));
    await page.getByLabel('노트 이미지 파일',{exact:true}).setInputFiles({name:'unsafe.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg onload="alert(1)"/>')});await page.getByRole('alert').filter({hasText:'PNG, JPEG, WebP, GIF'}).waitFor();assert.equal((await request('/api/notes/'+id)).content.markdown,stored);
    await page.reload();await ready(3);assert((await editor.textContent()).includes('Preserve after'));
    await page.getByRole('button',{name:'미리보기',exact:true}).click();const preview=page.getByTestId('markdown-preview');await preview.waitFor();await page.waitForFunction(()=>{const nodes=[...document.querySelectorAll('[data-testid="markdown-preview"] img')];return nodes.length===3&&nodes.every(n=>n.complete&&n.naturalWidth===1);});assert.equal(await preview.locator('img').count(),3);
    await page.getByRole('button',{name:'편집',exact:true}).click();await page.getByRole('button',{name:'편집 도구',exact:true}).click();await page.getByRole('button',{name:'원문',exact:true}).click();assert.equal(await page.getByLabel('Markdown 본문',{exact:true}).inputValue(),stored);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    console.log('PASS native note images: file-input/CDP, File clipboard/drop, actual decode, server ACK and Markdown, unsafe SVG rejection, preview/source/reload and original text preservation');
  }finally{if(created)await request('/api/notes/'+id,'DELETE');await page.goto(prior);}
}
