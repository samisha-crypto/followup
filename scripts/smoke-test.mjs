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
r = await anon.req('GET', '/'); ok(r.s === 200 && typeof r.j === 'string' && r.j.includes('function checkinsHtml()') && r.j.includes('data-act="ciDiscuss"') && r.j.includes('data-act="ciQuestion"') && r.j.includes('data-act="ciEdit"') && r.j.includes('data-act="writeTool"'), 'generated UI includes editable check-ins, question answers and rich-text composers');
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
r = await bob.req('POST', '/api/c/todolists', { pid: bobProj, title: 'Work' }); const workList = r.j.id; ok(r.s === 200 && workList, 'member creates a parent to-do list');
r = await bob.req('POST', '/api/c/todos', { pid: bobProj, title: 'Unparented task', to: 'x' }); ok(r.s === 403, 'server refuses to-dos without a parent list');
r = await bob.req('POST', '/api/c/todos', { pid: bobProj, listId: workList, title: 'My task', to: 'x', last: Date.now(), log: [] }); const todo = r.j.id; ok(r.s === 200, 'member adds a to-do under its project list');
r = await bob.req('GET', '/api/c/todos'); ok(r.j.find(t => t.id === todo)?.listId === workList, 'to-do references the parent list by id');
r = await admin.req('GET', '/api/c/todos'); ok(r.j.some(t => t.id === todo), 'admin sees the to-do');
r = await cat.req('GET', '/api/c/todos'); ok(r.j.length === 0, 'viewer without access sees nothing');
r = await cat.req('GET', '/api/c/projects'); ok(r.j.length === 0, 'viewer without access sees no projects');
r = await bob.req('PATCH', `/api/c/projects/${bobProj}`, { access: [ (await bob.req('GET','/api/me')).j.id, (await cat.req('GET','/api/me')).j.id ] }); ok(r.s === 200, 'creator grants access');
r = await cat.req('GET', '/api/c/todos'); ok(r.j.length === 1, 'viewer now sees the to-do');
r = await cat.req('PATCH', `/api/c/todos/${todo}`, { title: 'hacked' }); ok(r.s === 403, 'viewer cannot edit');
r = await bob.req('PATCH', `/api/c/members/${(await bob.req('GET','/api/me')).j.id}`, { role: 'admin' }); ok(r.s === 403, 'member cannot promote themselves');
r = await bob.req('PATCH', `/api/c/todos/${todo}`, { pid: secret }); ok(r.s === 403, 'cannot move a to-do into a project you cannot see');

console.log('Inbox & DMs');
const bobId = (await bob.req('GET', '/api/me')).j.id, aliceId = (await admin.req('GET', '/api/me')).j.id, catId = (await cat.req('GET', '/api/me')).j.id;
r = await admin.req('POST', '/api/c/inbox', { to: bobId, text: 'hello', pid: '', t: Date.now(), read: false, target: { type: 'todo', id: 'linked-todo', pid: 'project-1' } }); ok(r.s === 200, 'notification created');
r = await bob.req('GET', '/api/c/inbox'); ok(r.j.length === 1 && r.j[0].from === aliceId && r.j[0].target?.type === 'todo' && r.j[0].target.id === 'linked-todo', 'recipient sees notification target and server-stamped sender');
const inboxId = r.j[0]?.id;
r = await cat.req('GET', '/api/c/inbox'); ok(r.j.length === 0, 'others do not see it');
if (inboxId) {
  r = await admin.req('PATCH', `/api/c/inbox/${inboxId}`, { read: true }); ok(r.s === 403, 'sender cannot change recipient read state');
  r = await bob.req('PATCH', `/api/c/inbox/${inboxId}`, { read: true }); ok(r.s === 200, 'recipient can mark inbox message read');
  r = await bob.req('PATCH', `/api/c/inbox/${inboxId}`, { text: 'altered' }); ok(r.s === 403, 'recipient cannot edit inbox message contents');
  r = await cat.req('DELETE', `/api/c/inbox/${inboxId}`); ok(r.s === 403, 'non-participant cannot delete inbox message');
  r = await admin.req('DELETE', `/api/c/inbox/${inboxId}`); ok(r.s === 200, 'sender can delete an inbox message');
}
const k = [aliceId, bobId].sort().join('|');
r = await admin.req('POST', '/api/c/dms', { k, to: bobId, x: 'private', t: Date.now(), seen: false }); ok(r.s === 200, 'DM sent');
const dmId = r.j.id;
r = await admin.req('POST', '/api/c/dms', { k: [aliceId, catId].sort().join('|'), to: bobId, x: 'forged recipient' }); ok(r.s === 403, 'DM participant pair must include its recipient');
r = await cat.req('GET', '/api/c/dms'); ok(r.j.length === 0, 'third party cannot read DMs');
r = await bob.req('GET', '/api/c/dms'); ok(r.j.length === 1, 'participant reads DM');
if (dmId) {
  r = await admin.req('PATCH', `/api/c/dms/${dmId}`, { seen: true }); ok(r.s === 403, 'sender cannot set recipient seen state');
  r = await bob.req('PATCH', `/api/c/dms/${dmId}`, { seen: true }); ok(r.s === 200, 'recipient can mark DM seen');
  r = await cat.req('DELETE', `/api/c/dms/${dmId}`); ok(r.s === 403, 'non-participant cannot delete DM');
  r = await bob.req('DELETE', `/api/c/dms/${dmId}`); ok(r.s === 200, 'participant can delete DM');
  r = await admin.req('GET', '/api/c/dms'); ok(!r.j.some(x => x.id === dmId), 'deleted DM is no longer visible');
}

console.log('Project lists & personal preferences');
r = await bob.req('POST', '/api/c/todolists', { pid: bobProj, title: 'Planning' }); const list = r.j.id; ok(r.s === 200 && list, 'member creates a named to-do list');
r = await bob.req('GET', '/api/c/todolists'); ok(r.j.some(x => x.id === list && x.title === 'Planning'), 'project list persists');
r = await cat.req('PATCH', `/api/c/members/${catId}`, { theme: 'light', accent: 'rose' }); ok(r.s === 200, 'viewer can customize their own appearance');
r = await cat.req('PATCH', `/api/c/members/${catId}`, { theme: 'invalid' }); ok(r.s === 403, 'unsupported theme is rejected');

console.log('Automatic check-ins');
r = await admin.req('POST', '/api/c/checkins', { pid: bobProj, kind: 'plan', question: 'Weekly update?', recurrence: 'weekly', recipients: [bobId], nextAt: Date.now() + 86400000, timeZone: 'UTC', active: false });
const editablePlan = r.j.id; ok(r.s === 200 && editablePlan, 'owner creates an inactive check-in plan for edit tests');
r = await bob.req('PATCH', `/api/c/checkins/${editablePlan}`, { question: 'Unauthorized edit' }); ok(r.s === 403, 'non-owner cannot edit a check-in plan');
r = await admin.req('PATCH', `/api/c/checkins/${editablePlan}`, { question: 'Updated weekly update?', recurrence: 'daily', daysOfWeek: [1], recipients: [bobId], nextAt: Date.now() + 172800000, timeZone: 'UTC', dayOfMonth: 2 }); ok(r.s === 200, 'owner can edit a check-in question and schedule');
r = await admin.req('GET', '/api/c/checkins'); const updatedPlan = r.j.find(x => x.id === editablePlan);
ok(updatedPlan?.question === 'Updated weekly update?' && updatedPlan.recurrence === 'daily' && updatedPlan.active === false, 'edited schedule persists without resuming a paused check-in');
r = await admin.req('PATCH', `/api/c/checkins/${editablePlan}`, { daysOfWeek: [8] }); ok(r.s === 403, 'invalid schedule edits are rejected');
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
r = await admin.req('POST', '/api/c/checkins', { pid: bobProj, kind: 'plan', question: 'Weekday report?', recurrence: 'daily', daysOfWeek: [8], recipients: [bobId], nextAt: Date.now() - 1000, timeZone: 'UTC', active: true });
ok(r.s === 403, 'check-in weekday selections are range-validated');
const weekdayStart = Date.now() - 1000, weekday = (new Date(weekdayStart).getUTCDay() + 1) % 7;
r = await admin.req('POST', '/api/c/checkins', { pid: bobProj, kind: 'plan', question: 'Weekday report?', recurrence: 'daily', daysOfWeek: [weekday], recipients: [bobId], nextAt: weekdayStart, timeZone: 'UTC', active: true });
const weekdayPlan = r.j.id;
for (let i = 0; i < 20; i++) {
  await new Promise(resolve => setTimeout(resolve, 100));
  r = await admin.req('GET', '/api/c/checkins');
  const plan = r.j.find(x => x.id === weekdayPlan);
  if (plan?.nextAt > Date.now()) break;
}
const savedWeekday = r.j.find(x => x.id === weekdayPlan);
ok(!!savedWeekday && new Date(savedWeekday.nextAt).getUTCDay() === weekday, 'daily check-in recurrence skips unselected weekdays');
const biweeklyStart = Date.now() - 1000;
r = await admin.req('POST', '/api/c/checkins', { pid: bobProj, kind: 'plan', question: 'Biweekly report?', recurrence: 'biweekly', recipients: [bobId], nextAt: biweeklyStart, timeZone: 'UTC', active: true });
const biweeklyPlan = r.j.id;
for (let i = 0; i < 20; i++) {
  await new Promise(resolve => setTimeout(resolve, 100));
  r = await admin.req('GET', '/api/c/checkins');
  const plan = r.j.find(x => x.id === biweeklyPlan);
  if (plan?.nextAt > Date.now()) break;
}
const savedBiweekly = r.j.find(x => x.id === biweeklyPlan);
const expectedBiweekly = Math.floor(biweeklyStart / 60000) * 60000 + 14 * 86400000;
ok(!!savedBiweekly && Math.abs(savedBiweekly.nextAt - expectedBiweekly) < 5000, 'every-other-week schedule advances by two weeks');

console.log('Files');
r = await bob.req('POST', '/api/upload', Buffer.from('hello file'), { 'content-type': 'text/plain', 'x-filename': 'a.txt' }); const fid = r.j.id; ok(r.s === 200 && fid, 'upload works');
r = await bob.req('POST', '/api/c/files', { pid: bobProj, aid: fid, name: 'a.txt', size: 10, t: Date.now() }); ok(r.s === 200, 'file record saved');
r = await bob.req('POST', '/api/c/chat', { pid: bobProj, x: 'See the attachment', attachments: [{ aid: fid, name: 'a.txt', size: 10, type: 'text/plain' }] }); ok(r.s === 200, 'project messages accept owned attachments');
r = await cat.req('GET', `/_blob/${fid}`); ok(r.s === 200, 'project members can download an attached file');
r = await bob.req('POST', '/api/c/inbox', { to: catId, text: 'Private attachment', attachments: [{ aid: fid, name: 'a.txt', size: 10, type: 'text/plain' }] }); ok(r.s === 200, 'private inbox messages accept owned attachments');
r = await cat.req('GET', `/_blob/${fid}`); ok(r.s === 200, 'inbox recipient can access its attached file');
r = await bob.req('POST', '/api/c/dms', { k: [bobId, aliceId].sort().join('|'), to: aliceId, attachments: [{ aid: fid, name: 'a.txt', size: 10, type: 'text/plain' }] }); const attachedDmId = r.j.id;
ok(r.s === 200 && attachedDmId, 'direct messages accept attachment-only sends');
r = await admin.req('GET', '/api/c/dms'); ok(r.j.some(x => x.id === attachedDmId && x.attachments?.[0]?.aid === fid), 'DM participant can access attached message');
r = await cat.req('GET', `/_blob/${fid}`); ok(r.s === 200, 'DM participant can download its attached file');
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
