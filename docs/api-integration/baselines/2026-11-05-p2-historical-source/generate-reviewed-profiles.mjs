import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL,fileURLToPath} from 'node:url';
// This regenerates reviewed source data/code pins; it does not authorize source or runtime capability.
if(!process.argv.includes('--write-reviewed-profiles'))throw Error('Explicit --write-reviewed-profiles required');
const root=fileURLToPath(new URL('../../../../',import.meta.url)).replace(/\/$/u,'');
const ts=createRequire(root+'/package.json')('typescript');
const {historicalSourceSha256:hash}=await import(pathToFileURL(root+'/ops/platform/frontend-historical-source.mjs'));
const reviewedRevisions=['b99d4f346696f897fa6a6729dfcc52d6503fe8d6','74ca26736e5834fce639407278b4575bf4d05670','b5f7e08c5d264b66286062c60691f4d28d924294','d915619f11e198e6e1ef7cc1d4e9a2d644eb615a'];
const previews=JSON.parse(readFileSync(new URL('./preview-source-refs.json',import.meta.url),'utf8')).filter(r=>r.available).map(r=>r.sourceCommit);
const revisions=[...new Set([...reviewedRevisions,...previews])];
const referenceSignatures=new Map();
const sixAudit=JSON.parse(readFileSync(new URL('../2026-11-05-historical-capability-followup/reviewed-six-source-gates.json',import.meta.url),'utf8'));
const sixFamilyIds=['google.identity','google.oauth','google.calendar','sanity.editorial','sanity.callbacks','mux.studio'];
const git=(args,input)=>execFileSync('git',['--no-replace-objects','--no-optional-locks',...args],{cwd:root,input,maxBuffer:96000000});
const codeFile=f=>/^(?:src|scripts|ops)\//u.test(f)&&/\.(?:[cm]?[jt]sx?|py|sh)$/u.test(f)&&!/(?:^|\/)(?:tests|__tests__|__pycache__)(?:\/|$)|\.(?:test|spec)\./u.test(f);
const configurationFile=f=>['package.json','package-lock.json','vercel.json','vercel.mjs','next.config.ts','sanity.config.ts','sanity.cli.ts'].includes(f)||/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(f);
const provider=f=>/(?:highlevel|leadconnector)/iu.test(f)?'highlevel':/chitchats|\/shipping\//iu.test(f)?'chitchats':/resend|transactional-email|marketing-campaign|marketing-contact/iu.test(f)?'resend':/square/iu.test(f)?'square':/google|\/auth\.ts$/iu.test(f)?'google':/sanity/iu.test(f)?'sanity':/mux/iu.test(f)?'mux':null;
const expr=n=>ts.isIdentifier(n)?n.text:ts.isPropertyAccessExpression(n)?expr(n.expression)+'.'+n.name.text:ts.isElementAccessExpression(n)?expr(n.expression)+'[]':'<dynamic>';
const functionName=n=>{for(let p=n.parent;p;p=p.parent){if(ts.isFunctionDeclaration(p)||ts.isMethodDeclaration(p))return p.name?.getText()??'<anonymous>';if(ts.isArrowFunction(p)||ts.isFunctionExpression(p))return ts.isVariableDeclaration(p.parent)?p.parent.name.getText():'<callback>';}return'<module>';};
const string=n=>n&&(ts.isStringLiteralLike(n)||ts.isNoSubstitutionTemplateLiteral(n))?n.text:null;
const template=n=>ts.isTemplateExpression(n)?n.head.text+n.templateSpans.map(s=>'${}'+s.literal.text).join(''):string(n);
const families={
 square:['payments','refunds','orders','customers','cards','invoices','checkout','webhooks'],
 highlevel:['contacts','workflows','tasks','opportunities','conversations','messages','webhooks','oauth'],
 chitchats:['drafts','postage','refunds','tracking'],
 resend:['emails','contacts','segments','topics','events','broadcasts','templates','automations','webhooks'],
 google:['identity','oauth','calendar'],sanity:['editorial','callbacks'],mux:['studio','course-media'],
};
const notes={
 'chitchats.drafts':'C07 flat-rate probe create at flat-rate-refresh.ts:133 has no shipment/job/request intent; best-effort delete at193 can fail. Job-backed creates at operation-worker.ts:247/703 retain POST-before-persistence ambiguity; complete SQL jobs and stable empty provider lists do not prove no accepted transient request.',
 'chitchats.postage':'Purchase at operation-worker.ts:604 must match actual provider receipt and durable job/shipment; quote refreshes381/479 and operation settlement are independent effects.',
 'highlevel.contacts':'Direct upsert/PUT/DELETE paths do not all have pre-request intent rows. Privacy deletion scrubs provider IDs/effect payloads; current row absence cannot prove historical request absence.',
 'highlevel.workflows':'C07 sync.ts538-574 records workflow enrollment acknowledgment, not downstream execution completion; removals690-713 may treat404 as success. Pending effect rows may be deleted on nonambiguous failure; retention removes old outbox/webhook receipts.',
 'highlevel.messages':'Configured workflows can cause downstream messages independently after enrollment; lack of a direct conversations/messages call in frontend code does not establish downstream absence.',
 'highlevel.conversations':'Configured workflows can cause downstream conversations independently after enrollment; direct SDK absence is not downstream absence.',
 'square.customers':'C07 customer POSTs in service-card-on-file753-784 and service-charge-and-store2295-2333 precede persistence/checkpoint; training invoice customer/order/invoice requests also precede first SQL order.',
 'square.cards':'Standalone service-card-on-file881-914 creates provider card before checkpoint; no empty-list or hold-only inference can erase lost acknowledgment.',
 'square.invoices':'Training handler customer/order/invoice POSTs210/216/226 precede SQL231; publish244 precedes publication SQL251. No-show invoice357/373 precedes reference persistence436; best-effort delete448 does not settle lost responses.',
 'square.checkout':'Historical hosted checkout provider_checkout_id is payment_link.id, separate from provider_order_id. Exact provider object and callback state required.',
 'resend.events':'C07 marketing events.send can fail or remain unknown while the durable contact sync job is recorded succeeded; event/provider acceptance and downstream automation are separate.',
 'resend.broadcasts':'Create/send call staging bulk guard, but update/remove wrappers do not. Only verified original configuration plus exact reachable caller/guard paths can establish inapplicability; current flags or facade existence alone do not.',
 'resend.templates':'Tracked seed/update scripts can create/update/publish templates. No durable per-request SQL intent exists for these manual provider mutations.',
 'resend.automations':'Facade contains automation mutations; upstream event-driven automations and manually configured downstream behavior require actual provider evidence, not current SQL job state.',
 'google.calendar':'Both SQL encrypted/secret-ref grants and legacy scoped/unscoped Redis refresh tokens exist. Calendar insertion can precede stored event IDs; revoked clients and current empty SQL rows do not enumerate earlier requests.',
 'google.oauth':'Token exchange/refresh/revocation and callback persistence are separate; best-effort revoke does not establish completed provider state. Redis OAuth state and SQL grants require independent evidence.',
 'sanity.editorial':'Editorial/Studio credentials and browser author identity are distinct from private operational SQL; no blanket provider or token retirement follows from this profile.',
 'sanity.callbacks':'Inventory webhook and revalidation routes are distinct signed/deferred continuations; callbacks need actual source/config ingress and durable persistence evidence.',
 'mux.studio':'Sanity Mux Studio/public media is distinct from the new Course private media writer; do not infer credentials absent or retire unrelated media/signers.',
};
const tableMap={
 square:['checkout_orders','order_payment_obligations','order_payment_transactions','product_order_refunds','appointment_holds','booking_payment_attempts','booking_square_customers','booking_saved_payment_methods','booking_no_show_charge_records','booking_no_show_charge_attempts','checkout_payment_events','square_payment_refund_events'],
 highlevel:['highlevel_contacts','highlevel_effects','highlevel_outbox','highlevel_webhook_receipts','highlevel_connections','customer_email_outbox'],
 chitchats:['product_shipments','product_shipment_jobs','shipping_rate_cache','product_shipment_events'],
 resend:['marketing_contact_sync_jobs','marketing_contacts','marketing_campaigns','customer_email_outbox','marketing_consent_events','marketing_contact_submissions'],
 google:['booking_calendar_connections','booking_resource_calendar_assignments','appointment_calendar_events','appointment_holds','appointments','checkout_orders'],
 sanity:['product_stock','product_stock_movements'],mux:[],
};
const selectedSites=(family,sites)=>{const word=family.split('.')[1];const aliases={customers:'customer',cards:'card',payments:'payment|charge|capture',refunds:'refund',orders:'order',invoices:'invoice',segments:'segment',topics:'topic',broadcasts:'broadcast|campaign',templates:'template',automations:'automation',tasks:'task',opportunities:'opportunit',drafts:'create|draft|delete|quote|flat.rate',postage:'buy|purchase|postage',tracking:'track|refresh|shipment',identity:'auth|google',editorial:'create|patch|delete|studio|client',callbacks:'webhook|revalidate|inventory',emails:'email|send|transaction',oauth:'oauth|token|revoke|grant',workflows:'workflow|journey|durableEffect',contacts:'contact|sync|Dnd|privacy|retention',checkout:'checkout|payment.link',events:'event|send',studio:'mux|studio'};const pattern=new RegExp(aliases[word]??word,'iu');return sites.filter(s=>pattern.test(s.file+' '+s.callee+' '+s.symbol+' '+(s.endpoint??'')));};
const output={};
for(const sourceCommit of revisions){
 const treeOid=git(['rev-parse',sourceCommit+'^{tree}']).toString().trim();
 const all=git(['ls-tree','-rz','--full-tree',sourceCommit]).toString().split('\0').filter(Boolean).map(row=>{const i=row.indexOf('\t'),[mode,type,blobOid]=row.slice(0,i).split(' ');return{mode,type,blobOid,file:row.slice(i+1)};});
 const rows=all.filter(r=>codeFile(r.file)||configurationFile(r.file)).sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
 const batch=git(['cat-file','--batch'],rows.map(r=>r.blobOid+'\n').join(''));let offset=0;const bodies=new Map();
 for(const row of rows){let nl=batch.indexOf(10,offset);const parts=batch.subarray(offset,nl).toString().split(' '),length=Number(parts[2]);offset=nl+1;bodies.set(row.file,batch.subarray(offset,offset+length));offset+=length+1;}
 const entrypoints={routes:[],manual:[],schedules:[],deferred:[],actions:[],inlineActions:[],renders:[],dynamicExecution:[],sql:[]},sourceFiles=[],providerSites=[];
 for(const row of rows){const bytes=bodies.get(row.file),sha256=hash(bytes);sourceFiles.push({file:row.file,blobOid:row.blobOid,sha256});
  if(/^scripts\/|^ops\//u.test(row.file)&&codeFile(row.file))entrypoints.manual.push({file:row.file,blobOid:row.blobOid,sha256,scope:row.file.startsWith('scripts/')?'tracked-script':'operator-program-requires-selected-entrypoint'});
  if(!/\.[cm]?[jt]sx?$/u.test(row.file))continue;
  const text=bytes.toString(),ast=ts.createSourceFile(row.file,text,ts.ScriptTarget.Latest,true,/tsx$|jsx$/u.test(row.file)?ts.ScriptKind.TSX:ts.ScriptKind.TS);if(ast.parseDiagnostics.length)throw Error('parse:'+row.file);
  const imports=ast.statements.filter(ts.isImportDeclaration).map(s=>s.moduleSpecifier.text),moduleProvider=provider(row.file)??imports.map(provider).find(Boolean)??null;
  const deferredNames=new Set(['after','waitUntil','queueMicrotask','setTimeout','setInterval']);for(const statement of ast.statements)if(ts.isImportDeclaration(statement)&&['next/server','@vercel/functions'].includes(statement.moduleSpecifier.text)&&statement.importClause?.namedBindings&&ts.isNamedImports(statement.importClause.namedBindings))for(const element of statement.importClause.namedBindings.elements)if(['after','waitUntil'].includes(element.propertyName?.text??element.name.text))deferredNames.add(element.name.text);
  const exports=[];for(const statement of ast.statements){if(ts.isExportDeclaration(statement)&&statement.exportClause&&ts.isNamedExports(statement.exportClause)){exports.push(...statement.exportClause.elements.filter(e=>!e.isTypeOnly).map(e=>e.name.text));continue;}if(!statement.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))continue;if(ts.isFunctionDeclaration(statement)&&statement.name)exports.push(statement.name.text);if(ts.isVariableStatement(statement))for(const d of statement.declarationList.declarations){if(ts.isIdentifier(d.name))exports.push(d.name.text);else for(const e of d.name.elements)if(e.name&&ts.isIdentifier(e.name))exports.push(e.name.text);}if(ts.isExportDeclaration(statement)&&statement.exportClause&&ts.isNamedExports(statement.exportClause))exports.push(...statement.exportClause.elements.map(e=>e.name.text));}
  if(/^src\/app\/.*\/route\.[jt]s$/u.test(row.file))entrypoints.routes.push({file:row.file,blobOid:row.blobOid,sha256,methods:exports.filter(n=>['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(n))});
  if(ast.statements.some(s=>ts.isExpressionStatement(s)&&ts.isStringLiteral(s.expression)&&s.expression.text==='use server'))entrypoints.actions.push({file:row.file,exports,blobOid:row.blobOid,sha256});
  if(/^src\/app\/(?:.*\/)?(?:page|layout)\.[jt]sx?$/u.test(row.file))entrypoints.renders.push({file:row.file,blobOid:row.blobOid,sha256});
  const visit=node=>{if(ts.isFunctionLike(node)&&node.body&&ts.isBlock(node.body)&&node.body.statements.some(s=>ts.isExpressionStatement(s)&&ts.isStringLiteral(s.expression)&&s.expression.text==='use server'))entrypoints.inlineActions.push({file:row.file,blobOid:row.blobOid,sha256,line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,symbol:node.name?.getText(ast)??'<inline>'});
   if(ts.isTaggedTemplateExpression(node)&&/(?:^|\.)sql$/u.test(expr(node.tag))){const query=template(node.template);if(query!==null)entrypoints.sql.push({file:row.file,blobOid:row.blobOid,sha256,line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,symbol:functionName(node),verb:/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/iu.exec(query)?.[1].toUpperCase()??'FRAGMENT',tables:[...new Set([...query.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:public\.)?([a-z_][a-z0-9_]*)/giu)].map(m=>m[1].toLowerCase()))].sort(),querySha256:hash(query)});}
   if(ts.isCallExpression(node)){const callee=expr(node.expression),name=callee.split('.').at(-1),line=ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,symbol=functionName(node);
    const meta={file:row.file,blobOid:row.blobOid,sha256,lineStart:line,lineEnd:ast.getLineAndCharacterOfPosition(node.end).line+1,symbol,callee};
    meta.excerptSha256=hash(text.split('\n').slice(meta.lineStart-1,meta.lineEnd).join('\n'));
    if(deferredNames.has(name))entrypoints.deferred.push(meta);
    if(moduleProvider&&['then','catch','finally'].includes(name)&&(ts.isExpressionStatement(node.parent)||ts.isVoidExpression(node.parent)))entrypoints.deferred.push({...meta,kind:'unawaited-provider-continuation'});
    if(name==='eval'||node.expression.kind===ts.SyntaxKind.ImportKeyword&&string(node.arguments[0])===null)entrypoints.dynamicExecution.push(meta);
    const endpoint=node.arguments.map(template).find(s=>typeof s==='string'&&(s.startsWith('/')||/^https?:\/\//u.test(s)))??null;
    if((row.file.startsWith('src/')||row.file.startsWith('scripts/'))&&(['fetch','highlevel','request','createShipment','refreshShipment','buyShipment','refundShipment','deleteShipment','squareRequest','squareHttpRequest'].includes(name)||/\.(?:emails|contacts|broadcasts|templates|automations|events|customers|cards|payments|refunds|invoices|orders|segments|topics|calendarList)\./u.test(callee)||(moduleProvider&&/^(?:create|update|delete|send|remove|stop|refund|capture|publish|insert|patch|upsert)(?:[A-Z_]|$)/u.test(name))))providerSites.push({...meta,provider:provider(endpoint??'')??moduleProvider??'unclassified',endpoint});
   }
   if(ts.isObjectLiteralExpression(node)&&row.file==='ops/platform/vercel-config.mjs'){const p=n=>node.properties.find(x=>ts.isPropertyAssignment(x)&&x.name.getText(ast).replaceAll('"','')===n)?.initializer;const path=string(p('path')),schedule=string(p('schedule'));if(path&&schedule)entrypoints.schedules.push({path,schedule,file:row.file,blobOid:row.blobOid,sha256});}
   ts.forEachChild(node,visit);};visit(ast);
 }
 const inventory={version:1,scope:'exact-git-runtime-build-and-tracked-manual-source',sourceCommit,treeOid,parserVersion:ts.version,sourceFiles,entrypoints,
   providerPaths:providerSites.map(({endpoint,...s})=>({...s,endpointSha256:endpoint===null?null:hash(endpoint)})),
   configurations:all.filter(r=>configurationFile(r.file)).map(r=>({file:r.file,blobOid:r.blobOid,present:true})),
   absentConfigurations:['vercel.json'].filter(f=>!all.some(r=>r.file===f))};
 const lock=JSON.parse(bodies.get('package-lock.json')?.toString()??'{}');const sdkNames=['pg','drizzle-orm','resend','square','googleapis','google-auth-library','@upstash/redis','@sanity/client','next-auth','@auth/core','next-sanity','sanity','sanity-plugin-mux-input','@mux/mux-node','@mux/mux-player-react'];const sdkDependencies=sdkNames.flatMap(name=>{const p=lock.packages?.['node_modules/'+name]??lock.dependencies?.[name];return p?[{name,version:p.version,integrity:p.integrity??null}]:[];});
 const providerSignatures={};for(const name of Object.keys(families)){const selectedFiles=sourceFiles.filter(row=>row.file.startsWith('src/')||row.file.startsWith('scripts/')||['next.config.ts','vercel.mjs','sanity.config.ts','sanity.cli.ts'].includes(row.file));providerSignatures[name]=hash({selectedFiles,sdkDependencies});if(reviewedRevisions.includes(sourceCommit)){const signatures=referenceSignatures.get(name)??new Set();signatures.add(providerSignatures[name]);referenceSignatures.set(name,signatures);}}
 const auditedSix=sixAudit.profiles.find(p=>p.sourceCommit===sourceCommit);
 const sixReviewed=!!auditedSix&&auditedSix.files.every(expected=>expected.absent?!sourceFiles.some(r=>r.file===expected.file):sourceFiles.some(r=>r.file===expected.file&&r.blobOid===expected.blobOid&&r.sha256===expected.sha256))&&auditedSix.sdkDependencies.every(expected=>sdkDependencies.some(r=>r.name===expected.name&&r.version===expected.version&&r.integrity===expected.integrity));
 if(!sixReviewed)throw Error('Six-family source/SDK audit drift:'+sourceCommit);
 const muxStudioAbsent=!bodies.get('src/sanity/sanity.config.ts')?.toString().includes('sanity-plugin-mux-input')&&!bodies.has('src/sanity/schemas/documents/short-course.ts');
 const providerFamilies=[];
 for(const [name,names]of Object.entries(families))for(const suffix of names){const familyId=name+'.'+suffix,sites=providerSites.filter(s=>s.provider===name),specific=selectedSites(familyId,sites),relevant=specific.length?specific:sites;
  const inheritedSourceReview=reviewedRevisions.includes(sourceCommit)||referenceSignatures.get(name)?.has(providerSignatures[name]);const absent=(sixReviewed&&familyId==='mux.studio'&&muxStudioAbsent)||(inheritedSourceReview&&familyId==='mux.course-media'&&!sourceFiles.some(f=>/^src\/(?:lib\/(?:learning|customer-lifecycle)|app\/api\/learning)\//u.test(f.file)));
  const annotations=(absent?[]:relevant).sort((a,b)=>Number(!/createShipment|buyShipment|refundShipment|createCustomer|createCard|createInvoice|createOrder|publishInvoice|createPaymentLink|events\.send|^highlevel$/u.test(a.callee))-Number(!/createShipment|buyShipment|refundShipment|createCustomer|createCard|createInvoice|createOrder|publishInvoice|createPaymentLink|events\.send|^highlevel$/u.test(b.callee))).map(site=>Object.fromEntries(Object.entries(site).filter(([key])=>!['provider','endpoint','callee'].includes(key)))).filter((s,i,a)=>a.findIndex(x=>x.file===s.file&&x.lineStart===s.lineStart&&x.lineEnd===s.lineEnd&&x.symbol===s.symbol)===i).slice(0,24);
  let requiredCredentialPaths=[];
  if(name==='resend'&&suffix!=='webhooks')requiredCredentialPaths=[['RESEND_API_KEY']];if(familyId==='resend.webhooks')requiredCredentialPaths=[['RESEND_WEBHOOK_SECRET']];
  if(name==='square'&&suffix!=='webhooks')requiredCredentialPaths=[['SQUARE_ACCESS_TOKEN']];if(familyId==='square.webhooks')requiredCredentialPaths=[['SQUARE_WEBHOOK_SIGNATURE_KEY']];
  if(name==='chitchats')requiredCredentialPaths=[['CHITCHATS_ACCESS_TOKEN']];
  if(name==='highlevel'&&!['oauth','webhooks'].includes(suffix))requiredCredentialPaths=[['DATABASE_URL','HIGHLEVEL_CREDENTIAL_ENCRYPTION_KEY']];
  if(familyId==='highlevel.oauth')requiredCredentialPaths=[['DATABASE_URL','HIGHLEVEL_CLIENT_ID','HIGHLEVEL_CLIENT_SECRET']];if(familyId==='highlevel.webhooks')requiredCredentialPaths=[['DATABASE_URL','HIGHLEVEL_LOCATION_ID']];
  const credentialPathsReviewed=reviewedRevisions.includes(sourceCommit)||referenceSignatures.get(name)?.has(providerSignatures[name]);if(!credentialPathsReviewed)requiredCredentialPaths=[];
  const mutationExecutions=credentialPathsReviewed&&familyId==='resend.templates'?[{kind:'direct-caller',entrypoint:'scripts/seed-resend-templates.ts'},{kind:'direct-caller',entrypoint:'scripts/update-contact-popup-resend-template.ts'}]:undefined;const originalSelectorClosures=credentialPathsReviewed&&familyId==='resend.broadcasts'?[{kind:'deployment',key:'APP_ENV',equals:'staging',guard:'assertStagingBulkEmailDisabled at every reachable create/send caller; unused update/remove facade is not an entrypoint'}]:undefined;
  const privateSqlPredicate=sixReviewed&&sixFamilyIds.includes(familyId)?({
    'google.identity':'google-auth-signing-absence-v1',
    'google.oauth':'google-oauth-all-alternate-paths-v1',
    'google.calendar':'google-calendar-all-alternate-paths-v1',
    'sanity.callbacks':'sanity-signed-private-sql-ingress-v1',
    'sanity.editorial':'sanity-editorial-private-sql-scope-v1',
    'mux.studio':'mux-public-editorial-private-sql-scope-v1'
  })[familyId]:undefined;
  if(privateSqlPredicate){const files=auditedSix.files.filter(r=>!r.absent).map(r=>({...r,lineStart:1,lineEnd:bodies.get(r.file).toString().split('\n').length,symbol:privateSqlPredicate,excerptSha256:hash(bodies.get(r.file).toString())}));annotations.push(...files);}
  const configurationConditions=absent?[]:[{mutationExecutions,originalSelectorClosures,privateSqlPredicate,sourcePredicateReviewSha256:privateSqlPredicate?hash(auditedSix):undefined,requirementId:familyId+'.original-configuration',familyId,requiredCredentialPaths,
    guardScope:'All original key presence comes from the immutable complete record. Runtime flags alone are not closure: alternate direct/manual/callback paths exist.',annotations:annotations.slice(0,1)}];
  const schemaText=[...bodies.entries()].filter(([f])=>f.startsWith('src/')&&/schema\.[jt]s$/u.test(f)).map(([,b])=>b.toString()).join('\n'); const actualTables=new Set([...schemaText.matchAll(/(?:pgTable|\.table)\s*\(\s*["']([a-z_][a-z0-9_]*)["']/gu)].map(m=>m[1])); const tables=tableMap[name].filter(t=>actualTables.has(t));const sqlIntentRequirements=absent||tables.length===0?[]:[{requirementId:familyId+'.durable-intents',familyId,tables,
    requirement:'Bind every source-applicable durable intent/idempotency/provider/callback persistence record to actual provider acceptance and terminal outcomes. Current row absence/retention is not historical completeness.',annotations:annotations.slice(0,3)}];
  const untrackedPotentialRequests=absent?[]:[{requirementId:familyId+'.accepted-request-completeness',familyId,
    requirement:notes[familyId]??'Provider requests and pre-persistence/lost-acknowledgment/callback windows require complete actual accepted-request lifetime evidence; current SQL rows, empty provider lists, flags or current candidate admission do not prove zero.',annotations:annotations.slice(0,8)}];
  if(!absent&&suffix==='webhooks')untrackedPotentialRequests.push({requirementId:familyId+'.callback-persistence',familyId,requirement:'Actual original callback registration, complete inbound delivery/attempt history and durable persistence outcomes are independently required.',annotations:annotations.slice(0,4)});
  providerFamilies.push({familyId,provider:name,sourceDisposition:absent?'absent-from-verified-source':'reachable',sourceScope:absent?'No selected frontend writer/plugin for this exact source family; unrelated external media is separate.':privateSqlPredicate?'Frontend private SQL and protected continuations only; Google external identity and Sanity/Mux authenticated-user editorial/public media capabilities are not declared absent.':'Source-capable paths, including directly exported helpers and tracked manual callers; actual immutable invocation/configuration narrows applicability.',configurationConditions,sqlIntentRequirements,untrackedPotentialRequests,annotations});
 }
 const dbFiles=sourceFiles.filter(r=>r.file.startsWith('src/')&&/\.[cm]?[jt]sx?$/u.test(r.file));const dbReads=[];for(const f of dbFiles){const text=bodies.get(f.file).toString(),lines=text.split('\n');for(let index=0;index<lines.length;index++)for(const match of lines[index].matchAll(/(?:process\.env\.|env\.)([A-Z_]*(?:DATABASE_URL|POSTGRES_URL|DB_URL|PGPASSWORD|PGHOST|PGUSER|PGDATABASE|PGPORT|PGPASSFILE)[A-Z_]*)/gu))dbReads.push({key:match[1],annotation:{...f,lineStart:index+1,lineEnd:index+1,symbol:'source-SQL-credential-read',excerptSha256:hash(lines[index])}});}
 const sqlCredentialRequirements=[...new Set(dbReads.map(r=>r.key))].sort().map(key=>({requirementId:'sql-credentials.'+key,key,sourceScope:'deployment-and-supported-tracked-manual-entrypoints',annotations:dbReads.filter(r=>r.key===key).map(r=>r.annotation)}));
 const manualCredentialProfiles=['scripts/seed-resend-templates.ts','scripts/update-contact-popup-resend-template.ts','scripts/highlevel-backfill.ts','scripts/highlevel-config-check.ts'].filter(f=>bodies.has(f));
 const sourceReviewDisposition={kind:reviewedRevisions.includes(sourceCommit)?'audited-retained-staging-source':'preview-source-facts-conservative-capability-reuse',auditedPrivateSqlPredicateFamilies:sixFamilyIds,credentialPathReuseProviders:Object.keys(families).filter(name=>referenceSignatures.get(name)?.has(providerSignatures[name])),unknownCapabilityProviders:Object.keys(families).filter(name=>!referenceSignatures.get(name)?.has(providerSignatures[name]))};
 const profile={version:1,sourceCommit,treeOid,sdkDependencies,sourceReviewDisposition,sourceInventorySha256:hash(inventory),inventory,sqlCredentialRequirements,providerFamilies,manualCredentialProfiles};
 writeFileSync(root+'/ops/platform/profiles/frontend-historical-sources/'+sourceCommit+'.json',JSON.stringify(profile)+'\n');
 output[sourceCommit]={treeOid,profileSha256:hash(profile)};console.log(JSON.stringify({sourceCommit,files:sourceFiles.length,routes:entrypoints.routes.length,manual:entrypoints.manual.length,deferred:entrypoints.deferred.length,providerPaths:providerSites.length,families:providerFamilies.length,sourceInventorySha256:profile.sourceInventorySha256}));
}
const modulePath=root+'/ops/platform/frontend-historical-source.mjs';writeFileSync(modulePath,readFileSync(modulePath,'utf8').replace(/const approved = \{[\s\S]*?\n\};/u,'const approved = {\n'+Object.entries(output).map(([key,value])=>'  '+JSON.stringify(key)+': '+JSON.stringify(value)+',').join('\n')+'\n};'));
