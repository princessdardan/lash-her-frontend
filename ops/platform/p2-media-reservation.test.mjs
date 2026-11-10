import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,mkdtempSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {mediaReservationJoinedEvidence,validP2MediaReservationRequests} from './p2-certification-transport.mjs';
import {p2MediaReservationBody,readP2MediaReservationFile,validateP2InteractiveBrowserPermit,validateP2MediaReservationReceipt,
  watchP2MediaReservation} from './p2-lifecycle-browser-recorder.mjs';

const origin='https://staging.lashher.com';
const privateUpload='https://p2-media-upload.invalid/private?signature=fixture';
const bytes=Buffer.from([0,1,2,3,240,255,20,50,0,254]);
const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(currentVideoAssetId=null){
  const actorId=randomUUID(),courseId=randomUUID(),lessonId=randomUUID(),assetId=randomUUID();
  const selection={operation:'reserve-video-upload',courseId,lessonId,revision:11,currentVideoAssetId,
    fileSha256:sha(bytes),fileBytes:bytes.length,contentType:'video/mp4'};
  const pathname='/admin/courses/'+courseId, lesson='/api/admin/lessons/'+lessonId;
  const statusPath=lesson+'/video',uploadPath=lesson+'/video-upload';
  const readId=randomUUID(),postId=randomUUID(),uploadId='owned-upload';
  const receipt={page:{pathname,status:200},read:{requestId:readId,courseRevision:11,currentVideoAssetId},
    reservation:{requestId:postId,status:200,assetId,lessonId,uploadId,uploadTimeoutSeconds:3600,assetStatus:'uploading'},
    outbound:{intercepted:true,sent:false,fileSha256:selection.fileSha256,fileBytes:bytes.length,contentType:'video/mp4'}};
  const requests=[{method:'GET',target:'/course/v1/admin/courses/'+courseId,bodySha256:sha(''),uses:1},
    {method:'GET',target:'/course/v1/admin/lessons/'+lessonId+'/video',bodySha256:sha(''),uses:1},
    {method:'POST',target:'/course/v1/admin/lessons/'+lessonId+'/video-upload',
      bodySha256:sha(JSON.stringify(p2MediaReservationBody(selection))),uses:1}];
  const input={version:2,environment:'staging',actionId:'owned-media',challenge:'b'.repeat(64),bindingSha256:'c'.repeat(64),
    sourceCommit:'1'.repeat(40),deploymentId:'dpl_ownedBrowser',deploymentUrl:'https://owned-browser.vercel.app',
    browserOrigin:origin,stage:'media',epoch:'11',windowSeconds:30};
  const observed={gatewayAcknowledgements:[{requestId:randomUUID()},{requestId:readId},{requestId:postId}],gatewayEvidenceSha256:'d'.repeat(64)};
  return {selection,actorId,lessonId,courseId,pathname,statusPath,uploadPath,assetId,uploadId,readId,postId,receipt,requests,input,observed};
}

function privateFixture(t){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'p2-media-reservation-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'fixture.mp4');
  writeFileSync(path,bytes,{mode:0o600});
  return {root,path};
}

test('media review binds exact routes, private file, actor, reservation and gateway request IDs',t=>{
  for(const current of [null,randomUUID()]){
    const {selection,receipt,actorId,courseId,lessonId,requests,input,observed,postId}=fixture(current);
    assert.equal(validP2MediaReservationRequests(selection,requests),true);
    assert.equal(validP2MediaReservationRequests({...selection,currentVideoAssetId:undefined},requests),false);
    assert.equal(validP2MediaReservationRequests(selection,[requests[0],requests[2],requests[1]]),false);
    assert.equal(validP2MediaReservationRequests(selection,[...requests.slice(0,2),{...requests[2],bodySha256:sha('{}')}]),false);
    assert.equal(validateP2MediaReservationReceipt(receipt,selection),receipt);
    assert.throws(()=>validateP2MediaReservationReceipt({...receipt,reservation:{...receipt.reservation,status:201}},selection));
    assert.throws(()=>validateP2MediaReservationReceipt({...receipt,reservation:{...receipt.reservation,url:privateUpload}},selection));
    assert.throws(()=>validateP2MediaReservationReceipt({...receipt,outbound:{...receipt.outbound,sent:true}},selection));
    const target={actorId,...selection};
    const joined=mediaReservationJoinedEvidence({browserResponse:receipt},target,observed);
    assert.equal(joined.courseRevision,selection.revision+1);
    assert.equal(joined.isCurrent,current===null);
    assert.equal(joined.gatewayPostRequestId,postId);
    assert.throws(()=>mediaReservationJoinedEvidence({browserResponse:receipt},target,
      {...observed,gatewayAcknowledgements:[...observed.gatewayAcknowledgements.slice(0,2),{requestId:randomUUID()}]}));
    const {path,root}=privateFixture(t);
    assert.deepEqual(readP2MediaReservationFile(path,selection),bytes);
    assert.throws(()=>readP2MediaReservationFile(path,{...selection,fileSha256:'0'.repeat(64)}),/P2_MEDIA_FIXTURE_REFUSED/u);
    const link=join(root,'symlink.mp4');
    symlinkSync(path,link);
    assert.throws(()=>readP2MediaReservationFile(link,selection),/P2_MEDIA_FIXTURE_REFUSED/u);
    chmodSync(path,0o644);
    assert.throws(()=>readP2MediaReservationFile(path,selection),/P2_MEDIA_FIXTURE_REFUSED/u);
    const issued=Math.floor(Date.now()/1000),expires=issued+30;
    const permit={stage:'media',epoch:input.epoch,expires,
      cookie:['v2',input.epoch,'media',issued,expires,'a'.repeat(32),(actorId+courseId+lessonId).replaceAll('-',''),'e'.repeat(64)].join('.')};
    assert.equal(validateP2InteractiveBrowserPermit(permit,{...input,media:{...target,filePath:path}}),permit);
    assert.throws(()=>validateP2InteractiveBrowserPermit(permit,{...input,media:{...target,lessonId:randomUUID(),filePath:path}}));
  }
});

for(const scenario of ['reserve','unknown-status','explicit-external-options','external-image-after-reservation',
  'same-origin-image-after-reservation'])test('owned Chromium media scope '+scenario,{
  skip:process.env.P2_INTERACTIVE_BROWSER_OWNED_TEST!=='true',timeout:25_000,
},async t=>{
  const {chromium}=await import('playwright');
  const browser=await chromium.launch({args:['--host-resolver-rules=MAP * ~NOTFOUND']});
  t.after(()=>browser.close());
  const {selection,actorId,lessonId,pathname,statusPath,uploadPath,assetId,uploadId,readId,postId,receipt,input}=fixture();
  const {path}=privateFixture(t);
  const context=await browser.newContext({serviceWorkers:'block'});
  const page=await context.newPage(),calls=[];
  const html=`<p>draft · Revision 11</p><div data-lesson-id="${lessonId}"><button id="edit">Video and captions</button></div>
  <section aria-label="Open course editor" hidden><form><label>Video file<input name="video" type="file"></label>
  <button>Upload video</button></form></section><script>
  const panel=document.querySelector('section'),form=document.querySelector('form');
  document.querySelector('#edit').onclick=async()=>{await (await fetch(${JSON.stringify(statusPath)})).json();panel.hidden=false;};
  form.onsubmit=async event=>{event.preventDefault();const file=new FormData(form).get('video');
    ${scenario==='explicit-external-options'?`await fetch(${JSON.stringify(privateUpload)},{method:'OPTIONS'}).catch(()=>{});`:''}
    const {upload}=await (await fetch(${JSON.stringify(uploadPath)},{method:'POST',headers:{'content-type':'application/json'},
      body:${JSON.stringify(JSON.stringify(p2MediaReservationBody(selection)))}})).json();
    ${scenario.endsWith('image-after-reservation')?`await new Promise(done=>{const img=new Image();
      img.onload=img.onerror=done;img.src=${scenario.startsWith('same-origin')?`'/favicon.ico?data='+encodeURIComponent(upload.url)`:'upload.url'};});`:''}
    await fetch(upload.url,{method:'PUT',body:file,credentials:'omit',redirect:'error',mode:'cors',headers:{'content-type':file.type}});};
  </script>`;
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    calls.push([url.origin,url.pathname,request.method()]);
    if(url.origin!==origin)return route.abort();
    if(url.pathname===pathname)return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html});
    const json=(id,body)=>route.fulfill({status:200,headers:{'cache-control':'private, no-store','x-request-id':id},json:body});
    if(url.pathname===statusPath)return json(readId,{courseRevision:11,...(scenario==='unknown-status'?{}:{current:null}),latest:null});
    if(url.pathname===uploadPath)return json(postId,{upload:{id:uploadId,timeoutSeconds:3600,url:privateUpload},
      videoAsset:{id:assetId,lessonId,status:'uploading'}});
    return route.abort();
  });
  const watcher=watchP2MediaReservation(context,page,{...input,media:{actorId,...selection,filePath:path}});
  try{
    const expires=Math.floor(Date.now()/1000)+15;
    await watcher.open(expires);
    const expected=[[origin,pathname,'GET'],[origin,statusPath,'GET']];
    if(scenario==='reserve'){
      await watcher.wait(expires);
      assert.throws(()=>watcher.finish());
      await page.close();
      assert.deepEqual(watcher.finish(),receipt);
      assert.doesNotMatch(JSON.stringify(watcher.finish()),/private\?|signature=/u);
      expected.push([origin,uploadPath,'POST']);
    }else{
      await assert.rejects(watcher.wait(expires));
      await page.close();
      assert.throws(()=>watcher.finish());
      if(scenario.endsWith('image-after-reservation'))expected.push([origin,uploadPath,'POST']);
    }
    assert.deepEqual(calls,expected);
  }finally{await watcher.close();await context.close();}
});
