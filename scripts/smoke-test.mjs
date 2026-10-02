// End-to-end test. Starts nothing: run against a fresh server:  BASE=http://localhost:3000 node scripts/smoke-test.mjs
import ExcelJS from 'exceljs';
const BASE = process.env.BASE || 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  FAIL:', m)); if (c) console.log('  ok  :', m); };
class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, raw) {
    const h = { 'x-requested-with': 'fetch', cookie: this.cookie };
    if (body !== undefined && !raw) h['content-type'] = 'application/json';
    if (raw) Object.assign(h, raw);
    const r = await fetch(BASE + url, { method, headers: h, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j, headers: r.headers };
  }
}
const admin = new Client(), bob = new Client(), cat = new Client(), anon = new Client();
let r;
console.log('Auth');
r = await anon.req('GET', '/api/me'); ok(r.s === 401, 'anonymous cannot read /api/me');
r = await anon.req('GET', '/api/c/todos'); ok(r.s === 401, 'anonymous cannot read data');
r = await admin.req('POST', '/api/signup', { name: 'Alice Admin', email: 'alice@x.io', password: 'password123' }); ok(r.s === 200, 'first signup works (becomes admin)');
r = await admin.req('GET', '/api/me'); ok(r.j.owner === true && r.j.name === 'Alice Admin', 'first user is owner');
r = await bob.req('POST', '/api/signup', { name: 'Bob Member', email: 'bob@x.io', password: 'password123' }); ok(r.s === 403, 'signup without invite code is refused');
r = await admin.req('POST', '/api/c/invites', { code: 'TEST-CODE', role: 'member', max: 1, uses: 0, exp: 0 }); ok(r.s === 200, 'admin creates invite');
r = await bob.req('POST', '/api/signup', { name: 'Bob Member', email: 'bob@x.io', password: 'password123', code: 'test-code' }); ok(r.s === 200, 'signup with invite code works');
r = await cat.req('POST', '/api/signup', { name: 'Cat Two', email: 'cat@x.io', password: 'password123', code: 'TEST-CODE' }); ok(r.s === 403, 'invite code cannot be reused');
r = await bob.req('POST', '/api/login', { email: 'bob@x.io', password: 'nope' }); ok(r.s === 401, 'wrong password rejected');
r = await bob.req('GET', '/api/c/invites'); ok(Array.isArray(r.j) && r.j.length === 0, 'members cannot see invite codes');
r = await admin.req('POST', '/api/admin/users', { name: 'Cat Viewer', email: 'cat@x.io', role: 'viewer', position: 'Quality Analyst' }); ok(r.s === 200 && r.j.password, 'admin creates a user with temp password');
r = await cat.req('POST', '/api/login', { email: 'cat@x.io', password: r.j.password }); ok(r.s === 200, 'created user can log in');
r = await cat.req('GET', '/api/me'); const catProfileId = r.j.id;
r = await cat.req('GET', `/api/profiles?ids=${catProfileId}`); ok(r.j[catProfileId]?.position === 'Quality Analyst', 'profile API exposes admin-managed positions');
const workbook = new ExcelJS.Workbook(), usersSheet = workbook.addWorksheet('Users');
usersSheet.addRow(['Full Name', 'Email', 'Temporary Password', 'Role', 'Position']);
usersSheet.addRow(['Dana Import', 'dana@x.io', 'temp-password-1', 'member', 'Designer']);
usersSheet.addRow(['Duplicate Dana', 'dana@x.io', 'temp-password-2', 'member', 'Designer']);
const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
r = await admin.req('POST', '/api/admin/users/import', xlsx, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
ok(r.s === 200 && r.j.created.length === 1 && r.j.created[0].password === 'temp-password-1' && r.j.rejected.length === 1, 'Excel import creates valid users and reports duplicate rows');
const danaId = r.j.created[0]?.id;
r = await admin.req('GET', `/api/profiles?ids=${danaId}`); ok(r.j[danaId]?.position === 'Designer', 'Excel import persists each user position');
r = await anon.req('GET', '/api/admin/users/import-template'); ok(r.s === 401, 'anonymous users cannot download the Excel template');
r = await admin.req('GET', '/api/admin/users/import-template'); ok(r.s === 200 && r.headers.get('content-type')?.includes('spreadsheetml') && r.headers.get('content-disposition')?.includes('.xlsx'), 'admin can download the Excel template');

console.log('Project privacy');
r = await bob.req('POST', '/api/c/projects', { name: 'Bob private', access: [] }); const bobProj = r.j.id; ok(r.s === 200, 'member creates project');
r = await admin.req('POST', '/api/c/projects', { name: 'Admin secret', access: [] }); const secret = r.j.id;
r = await bob.req('GET', '/api/c/projects'); ok(r.j.length === 1 && r.j[0].name === 'Bob private', 'member sees only own project');
r = await admin.req('GET', '/api/c/projects'); ok(r.j.length === 2, 'admin sees every project');
r = await bob.req('POST', '/api/c/todos', { pid: secret, title: 'sneaky', to: 'x' }); ok(r.s === 403, 'member cannot add to-do in a project they cannot see');
r = await bob.req('POST', '/api/c/todos', { pid: bobProj, title: 'My task', to: 'x', last: Date.now(), log: [] }); const todo = r.j.id; ok(r.s === 200, 'member adds to-do in own project');
r = await admin.req('GET', '/api/c/todos'); ok(r.j.some(t => t.id === todo), 'admin sees the to-do');
r = await cat.req('GET', '/api/c/todos'); ok(r.j.length === 0, 'viewer without access sees nothing');
r = await cat.req('GET', '/api/c/projects'); ok(r.j.length === 0, 'viewer without access sees no projects');
r = await bob.req('PATCH', `/api/c/projects/${bobProj}`, { access: [ (await bob.req('GET','/api/me')).j.id, (await cat.req('GET','/api/me')).j.id ] }); ok(r.s === 200, 'creator grants access');
r = await cat.req('GET', '/api/c/todos'); ok(r.j.length === 1, 'viewer now sees the to-do');
r = await cat.req('PATCH', `/api/c/todos/${todo}`, { title: 'hacked' }); ok(r.s === 403, 'viewer cannot edit');
r = await bob.req('PATCH', `/api/c/members/${(await bob.req('GET','/api/me')).j.id}`, { role: 'admin' }); ok(r.s === 403, 'member cannot promote themselves');
r = await bob.req('PATCH', `/api/c/todos/${todo}`, { pid: secret }); ok(r.s === 403, 'cannot move a to-do into a project you cannot see');

console.log('Inbox & DMs');
const bobId = (await bob.req('GET', '/api/me')).j.id, aliceId = (await admin.req('GET', '/api/me')).j.id;
r = await admin.req('POST', '/api/c/inbox', { to: bobId, text: 'hello', pid: '', t: Date.now(), read: false }); ok(r.s === 200, 'notification created');
r = await bob.req('GET', '/api/c/inbox'); ok(r.j.length === 1 && r.j[0].from === aliceId, 'recipient sees it, sender is stamped by server');
r = await cat.req('GET', '/api/c/inbox'); ok(r.j.length === 0, 'others do not see it');
const k = [aliceId, bobId].sort().join('|');
r = await admin.req('POST', '/api/c/dms', { k, to: bobId, x: 'private', t: Date.now(), seen: false }); ok(r.s === 200, 'DM sent');
r = await cat.req('GET', '/api/c/dms'); ok(r.j.length === 0, 'third party cannot read DMs');
r = await bob.req('GET', '/api/c/dms'); ok(r.j.length === 1, 'participant reads DM');

console.log('Project lists & personal preferences');
r = await bob.req('POST', '/api/c/todolists', { pid: bobProj, title: 'Planning' }); const list = r.j.id; ok(r.s === 200 && list, 'member creates a named to-do list');
r = await bob.req('GET', '/api/c/todolists'); ok(r.j.some(x => x.id === list && x.title === 'Planning'), 'project list persists');
const catId = (await cat.req('GET', '/api/me')).j.id;
r = await cat.req('PATCH', `/api/c/members/${catId}`, { theme: 'light', accent: 'rose' }); ok(r.s === 200, 'viewer can customize their own appearance');
r = await cat.req('PATCH', `/api/c/members/${catId}`, { theme: 'invalid' }); ok(r.s === 403, 'unsupported theme is rejected');

console.log('Automatic check-ins');
r = await admin.req('POST', '/api/c/checkins', { pid: bobProj, kind: 'plan', question: 'What did you finish?', recurrence: 'once', recipients: [bobId], nextAt: Date.now() - 1000, timeZone: 'UTC', active: true });
const checkinPlan = r.j.id; ok(r.s === 200 && checkinPlan, 'project member schedules a one-time check-in');
r = await admin.req('POST', '/api/c/checkinRequests', { pid: bobProj, to: bobId, question: 'Forged request' }); ok(r.s === 403, 'clients cannot forge generated check-in requests');
let checkinRequest;
for (let i = 0; i < 20 && !checkinRequest; i++) {
  await new Promise(resolve => setTimeout(resolve, 100));
  r = await bob.req('GET', '/api/c/checkinRequests');
  checkinRequest = r.j.find(x => x.planId === checkinPlan);
}
ok(!!checkinRequest, 'due schedule generates a recipient-specific request');
if (checkinRequest) {
  r = await bob.req('POST', '/api/c/checkinAnswers', { pid: bobProj, requestId: checkinRequest.id, x: 'Finished the review' }); const answerId = r.j.id;
  ok(r.s === 200 && answerId, 'only the recipient can answer their request');
  r = await bob.req('GET', '/api/c/checkinAnswers'); ok(Number.isFinite(r.j.find(x => x.id === answerId)?.t), 'answers receive server timestamps');
  r = await cat.req('GET', '/api/c/checkinAnswers'); ok(!r.j.some(x => x.id === answerId), 'other project members cannot read private recipient answers');
  r = await bob.req('POST', '/api/c/checkinAnswers', { pid: bobProj, requestId: checkinRequest.id, x: 'Duplicate answer' }); ok(r.s === 403, 'a request only accepts one answer');
  r = await admin.req('POST', '/api/c/checkinComments', { pid: bobProj, requestId: checkinRequest.id, answerId, x: 'Thanks for the update' }); ok(r.s === 200, 'project members can comment on the answer');
  r = await bob.req('GET', '/api/c/checkinComments'); ok(r.j.some(x => x.answerId === answerId && Number.isFinite(x.t)), 'answer thread comments are readable with server timestamps');
  r = await cat.req('GET', '/api/c/checkinComments'); ok(!r.j.some(x => x.answerId === answerId), 'other project members cannot read private answer comments');
  r = await bob.req('DELETE', `/api/c/checkinAnswers/${answerId}`); ok(r.s === 200, `recipient can delete their own answer (${r.s}: ${JSON.stringify(r.j)})`);
  r = await bob.req('GET', '/api/c/checkinAnswers'); ok(!r.j.some(x => x.id === answerId), 'deleted answer is no longer visible');
  r = await bob.req('GET', '/api/c/checkinComments'); ok(!r.j.some(x => x.answerId === answerId), 'deleting an answer also removes its comments');
}
r = await bob.req('GET', '/api/c/inbox'); ok(r.j.some(x => x.k === 'checkin'), 'scheduled check-in notifies its recipient');
r = await admin.req('POST', '/api/c/checkins', { pid: bobProj, kind: 'plan', question: 'Daily report?', recurrence: 'daily', recipients: [bobId], nextAt: Date.now() - 86400000, timeZone: 'UTC', active: true });
const dailyPlan = r.j.id;
for (let i = 0; i < 20; i++) {
  await new Promise(resolve => setTimeout(resolve, 100));
  r = await admin.req('GET', '/api/c/checkins');
  if (r.j.find(x => x.id === dailyPlan)?.nextAt > Date.now()) break;
}
const savedDaily = r.j.find(x => x.id === dailyPlan);
ok(!!savedDaily && savedDaily.nextAt > Date.now(), 'daily schedule advances to its next occurrence');

console.log('Files');
r = await bob.req('POST', '/api/upload', Buffer.from('hello file'), { 'content-type': 'text/plain', 'x-filename': 'a.txt' }); const fid = r.j.id; ok(r.s === 200 && fid, 'upload works');
r = await bob.req('POST', '/api/c/files', { pid: bobProj, aid: fid, name: 'a.txt', size: 10, t: Date.now() }); ok(r.s === 200, 'file record saved');
r = await bob.req('POST', '/api/c/chat', { pid: bobProj, x: 'See the attachment', attachments: [{ aid: fid, name: 'a.txt', size: 10, type: 'text/plain' }] }); ok(r.s === 200, 'project messages accept owned attachments');
r = await cat.req('GET', `/_blob/${fid}`); ok(r.s === 200, 'project members can download an attached file');
r = await bob.req('POST', '/api/c/inbox', { to: catId, text: 'Private attachment', attachments: [{ aid: fid, name: 'a.txt', size: 10, type: 'text/plain' }] }); ok(r.s === 200, 'private inbox messages accept owned attachments');
r = await cat.req('GET', `/_blob/${fid}`); ok(r.s === 200, 'inbox recipient can access its attached file');
r = await bob.req('PATCH', `/api/c/members/${bobId}`, { avatar: fid }); ok(r.s === 200, 'users can set their own uploaded picture');
r = await cat.req('GET', `/api/profiles?ids=${bobId}`); ok(r.j[bobId]?.avatar === fid, 'team profiles expose the picture for mentions');
r = await admin.req('POST', '/api/upload', Buffer.from('private file'), { 'content-type': 'text/plain', 'x-filename': 'private.txt' }); const privateFid = r.j.id;
r = await bob.req('POST', '/api/c/chat', { pid: bobProj, x: 'forged attachment', attachments: [{ aid: privateFid, name: 'private.txt' }] }); ok(r.s === 403, 'users cannot attach another person’s unlinked upload');
r = await bob.req('GET', `/_blob/${fid}`); ok(r.s === 200 && r.j === 'hello file', 'owner downloads file');
r = await anon.req('GET', `/_blob/${fid}`); ok(r.s === 401, 'anonymous cannot download');
r = await admin.req('POST', '/api/c/projects', { name: 'Other', access: [] });
const other = new Client(); await other.req('POST', '/api/admin/users', {}); // no-op
r = await bob.req('POST', '/api/upload', Buffer.from('project restricted'), { 'content-type': 'text/plain', 'x-filename': 'restricted.txt' }); const restrictedFid = r.j.id;
r = await bob.req('POST', '/api/c/files', { pid: bobProj, aid: restrictedFid, name: 'restricted.txt', size: 18, t: Date.now() }); ok(r.s === 200, 'project-only test file linked');
r = await admin.req('POST', '/api/admin/users', { name: 'Dan Member', email: 'dan@x.io', role: 'member' }); const dan = new Client();
await dan.req('POST', '/api/login', { email: 'dan@x.io', password: r.j.password });
r = await dan.req('GET', `/_blob/${restrictedFid}`); ok(r.s === 403, 'user without project access cannot download');
r = await dan.req('GET', `/_blob/${fid}`); ok(r.s === 200, 'team can view an uploaded profile picture');

console.log('Realtime');
const ac = new AbortController(); const sr = await fetch(BASE + '/api/stream', { headers: { cookie: admin.cookie }, signal: ac.signal });
const reader = sr.body.getReader(); await reader.read();
await bob.req('POST', '/api/c/chat', { pid: bobProj, x: 'ping', t: Date.now() });
const got = await Promise.race([reader.read().then(x => new TextDecoder().decode(x.value)), new Promise(res => setTimeout(() => res(''), 3000))]);
ok(got.includes('chat'), 'SSE pushes change events'); ac.abort();

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
