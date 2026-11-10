import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {mediaReservationJoinedEvidence,validP2MediaReservationRequests} from './p2-certification-transport.mjs';
import {p2MediaReservationBody,p2MediaUploadCallbackOperation,readP2MediaReservationFile,validP2MediaReservationAction,
  validateP2InteractiveBrowserPermit,validateP2MediaDispatchIntent,validateP2MediaDispatchReceipt,validateP2MediaReservationReceipt,
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

test('media dispatch validates a live bounded intent and exposes only completed status',()=>{
  const {selection}=fixture();
  assert.equal(validP2MediaReservationAction({...selection,operation:p2MediaUploadCallbackOperation}),true);
  assert.equal(validP2MediaReservationAction({...selection,operation:'dispatch-arbitrary-upload'}),false);
  const intent={intentSha256:'1'.repeat(64),expiresAt:105};
  assert.equal(validateP2MediaDispatchIntent(intent,110,100),intent);
  for(const invalid of [{...intent,expiresAt:100},{...intent,expiresAt:111},{...intent,intentSha256:'0'.repeat(64)},
    {...intent,url:privateUpload}])assert.throws(()=>validateP2MediaDispatchIntent(invalid,110,100));
  const receipt={attempted:true,status:204};
  assert.equal(validateP2MediaDispatchReceipt(receipt),receipt);
  for(const invalid of [{attempted:false,status:204},{attempted:true,status:502},{...receipt,url:privateUpload}]){
    assert.throws(()=>validateP2MediaDispatchReceipt(invalid));
  }
});

test('owned Chromium releases the original signed PUT at most once, without forwarding editor refreshes',{
  skip:process.env.P2_INTERACTIVE_BROWSER_OWNED_TEST!=='true',timeout:40_000,
},async t=>{
  const {chromium}=await import('playwright');
  const {root,path}=privateFixture(t),key=join(root,'tls-key.pem'),cert=join(root,'tls-cert.pem');
  const uploadUrl=new URL(privateUpload),sockets=new Set(),calls=[];
  assert.equal(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj',`/CN=${uploadUrl.hostname}`,
    '-keyout',key,'-out',cert],{stdio:'ignore'}).status,0);
  const track=socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));};
  const listen=server=>new Promise((resolve,reject)=>{
    server.on('connection',track);
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>resolve(server.address().port));
  });
  let scenario;
  const tls=createHttpsServer({key:readFileSync(key),cert:readFileSync(cert)},async(req,res)=>{
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    calls.push({method:req.method,path:req.url,headers:req.headers,body:Buffer.concat(chunks)});
    if(scenario==='lost-response'){res.destroy();return;}
    if(scenario==='redirect-response'){res.writeHead(307,{location:uploadUrl.origin+'/redirected'}).end();return;}
    if(scenario==='valid-200'){
      res.writeHead(200,{'access-control-allow-origin':origin,'content-type':'text/plain'});
      res.end('complete');
    }else res.writeHead(204,{'access-control-allow-origin':origin}).end();
  });
  const proxy=createHttpServer((_req,res)=>res.writeHead(403).end());
  let browser;
  try{
    const tlsPort=await listen(tls);
    proxy.on('connect',(request,socket,head)=>{
      if(request.url!==uploadUrl.hostname+':443'){socket.destroy();return;}
      const target=connect(tlsPort,'127.0.0.1');
      track(target);
      target.once('error',()=>socket.destroy());
      socket.once('error',()=>target.destroy());
      target.once('connect',()=>{
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        if(head.length)target.write(head);
        socket.pipe(target).pipe(socket);
      });
    });
    const proxyPort=await listen(proxy);
    browser=await chromium.launch({args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    for(scenario of ['valid-200','valid-204','expired','lost-response','redirect-response']){
      const {selection,actorId,lessonId,pathname,statusPath,uploadPath,assetId,uploadId,readId,postId,receipt,input}=fixture();
      const context=await browser.newContext({serviceWorkers:'block',proxy:{server:`http://127.0.0.1:${proxyPort}`},ignoreHTTPSErrors:true});
      const page=await context.newPage(),frontend=[];
      const detail='/api/admin/courses/'+selection.courseId;
      const html=`<p>draft · Revision 11</p><div data-lesson-id="${lessonId}"><button id="edit">Video and captions</button></div>
        <section aria-label="Open course editor" hidden><form><label>Video file<input name="video" type="file"></label>
        <button>Upload video</button></form></section><script>
        const panel=document.querySelector('section'),form=document.querySelector('form');
        document.querySelector('#edit').onclick=async()=>{await (await fetch(${JSON.stringify(statusPath)})).json();panel.hidden=false;};
        form.onsubmit=async event=>{event.preventDefault();const file=new FormData(form).get('video');
          const {upload}=await (await fetch(${JSON.stringify(uploadPath)},{method:'POST',headers:{'content-type':'application/json'},
            body:${JSON.stringify(JSON.stringify(p2MediaReservationBody(selection)))}})).json();
          try { await fetch(upload.url,{method:'PUT',body:file,credentials:'omit',redirect:'error',mode:'cors',headers:{'content-type':file.type}});
            await fetch(${JSON.stringify(statusPath)}); }
          finally { await fetch(${JSON.stringify(detail)}); } };
        </script>`;
      await context.addCookies([{url:uploadUrl.origin,name:'private-fixture-cookie',value:'fixture',secure:true,sameSite:'None'}]);
      await context.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url());
        frontend.push([url.origin,url.pathname,request.method()]);
        if(url.origin!==origin)return route.abort();
        if(url.pathname===pathname)return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html});
        const json=(id,body)=>route.fulfill({status:200,headers:{'cache-control':'private, no-store','x-request-id':id},json:body});
        if(url.pathname===statusPath)return json(readId,{courseRevision:11,current:null,latest:null});
        if(url.pathname===uploadPath)return json(postId,{upload:{id:uploadId,timeoutSeconds:3600,url:privateUpload},
          videoAsset:{id:assetId,lessonId,status:'uploading'}});
        return route.abort();
      });
      const watcher=watchP2MediaReservation(context,page,{...input,media:{actorId,...selection,
        operation:p2MediaUploadCallbackOperation,filePath:path}});
      const previous=calls.length;
      try{
        const expires=Math.floor(Date.now()/1000)+15;
        await watcher.open(expires);
        await watcher.wait(expires);
        assert.deepEqual(watcher.hold(expires),receipt);
        assert.equal(calls.length,previous);
        const intent={intentSha256:'1'.repeat(64),expiresAt:scenario==='expired'?Math.floor(Date.now()/1000):expires};
        if(scenario.startsWith('valid-'))assert.deepEqual(await watcher.dispatch(intent),{attempted:true,status:Number(scenario.slice(6))});
        else await assert.rejects(watcher.dispatch(intent),/P2_MEDIA_DISPATCH_REFUSED/u);
        assert.equal(page.isClosed(),true);
        await assert.rejects(watcher.dispatch({...intent,expiresAt:expires}),/P2_MEDIA_DISPATCH_REFUSED/u);
        assert.deepEqual(frontend,[[origin,pathname,'GET'],[origin,statusPath,'GET'],[origin,uploadPath,'POST']]);
        if(scenario==='expired')assert.equal(calls.length,previous);
        else{
          assert.equal(calls.length,previous+1);
          const wire=calls[previous];
          assert.equal(wire.method,'PUT');
          assert.equal(wire.path,uploadUrl.pathname+uploadUrl.search);
          assert.equal(wire.headers.origin,origin);
          assert.equal(wire.headers['content-type'],'video/mp4');
          assert.equal(wire.headers.cookie,undefined);
          assert.equal(wire.headers.authorization,undefined);
          assert.deepEqual(wire.body,bytes);
        }
      }finally{await watcher.close();await context.close();}
    }
  }finally{
    await browser?.close();
    for(const socket of sockets)socket.destroy();
    await Promise.all([tls,proxy].map(server=>new Promise(resolve=>server.close(()=>resolve()))));
  }
});
