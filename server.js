// FollowUp server — Fastify + SQLite. Server-side auth, roles, project privacy, uploads, push & email.
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createStorage } from './storage.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = +env.PORT || 3000, HOST = env.HOST || '0.0.0.0';
const DATA = path.resolve(env.DATA_DIR || path.join(__dir, 'data'));
const VERCEL = !!env.VERCEL;
const SECURE = VERCEL || env.COOKIE_SECURE === 'true';
const BLOB_AUTH_CONFIGURED = !!env.BLOB_READ_WRITE_TOKEN || !!(env.BLOB_STORE_ID && env.VERCEL_OIDC_TOKEN);
const BASE = (env.BASE_URL || '').replace(/\/$/, '');
const APP = env.APP_NAME || 'FollowUp';
const MAX_UPLOAD = Math.min((+env.MAX_UPLOAD_MB || 25) * 1024 * 1024, VERCEL ? 4 * 1024 * 1024 : Infinity);
const DAY = 864e5;
if (!env.DATABASE_URL) fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });
const store = await createStorage({ dataDir: DATA, databaseUrl: env.DATABASE_URL });
if (VERCEL && (!env.DATABASE_URL || !BLOB_AUTH_CONFIGURED)) throw new Error('Vercel deployments require DATABASE_URL and private Blob credentials (BLOB_READ_WRITE_TOKEN or the connected store OIDC variables).');
const blobStore = VERCEL ? await import('@vercel/blob') : null;
const nid = () => crypto.randomBytes(10).toString('hex');
const getDoc = (c, i) => store.getDoc(c, i);
const putDoc = (c, i, d) => store.putDoc(c, i, d);
const delDoc = (c, i) => store.deleteDoc(c, i);
const allDocs = c => store.allDocs(c);
const strip = ({ id, ...r }) => r;
async function migrateTodoLists() {
  const lists = await allDocs('todolists');
  const todos = await allDocs('todos');
  for (const todo of todos) {
    const linked = lists.find(list => list.id === todo.listId && list.pid === todo.pid);
    if (linked) continue;
    const title = String(todo.list || 'To-dos').trim() || 'To-dos';
    let list = lists.find(item => item.pid === todo.pid && String(item.title || '').toLowerCase() === title.toLowerCase());
    if (!list) {
      const project = await getDoc('projects', todo.pid);
      list = { id: nid(), pid: todo.pid, title, by: todo.by || project?.by || 'system', t: todo.created || Date.now() };
      await putDoc('todolists', list.id, strip(list));
      lists.push(list);
    }
    await putDoc('todos', todo.id, { ...strip(todo), listId: list.id, list: list.title });
  }
}
await migrateTodoLists();

/* ---------- passwords & sessions ---------- */
const hashPw = pw => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const checkPw = (pw, st) => { const [s, h] = st.split(':'); const x = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64); return crypto.timingSafeEqual(x, Buffer.from(h, 'hex')); };
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const tempPw = () => crypto.randomBytes(9).toString('base64url');
function startSession(reply, uid) {
  const t = crypto.randomBytes(32).toString('hex');
  return store.saveSession(sha(t), uid, Date.now() + 30 * DAY).then(() => {
  reply.setCookie('sid', t, { path: '/', httpOnly: true, sameSite: 'lax', secure: SECURE, maxAge: 30 * 86400 });
  });
}
const tries = new Map();
function throttle(req) {
  const k = req.ip, now = Date.now(), r = tries.get(k) || { n: 0, reset: now + 15 * 60e3 };
  if (now > r.reset) { r.n = 0; r.reset = now + 15 * 60e3; }
  r.n++; tries.set(k, r); return r.n > 20;
}

/* ---------- roles & visibility ---------- */
const roleOf = async uid => { const u = await store.getUser(uid); if (!u) return 'none'; if (u.owner) return 'admin'; return (await getDoc('members', uid))?.role || 'none'; };
const isWriter = r => r === 'admin' || r === 'member';
const visibleProjects = async (uid, role) => new Set((await allDocs('projects')).filter(p => role === 'admin' || p.by === uid || (p.access || []).includes(uid)).map(p => p.id));
async function validCheckinPlan(uid, role, plan) {
  let zoneOk = false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: plan.timeZone || 'UTC' }); zoneOk = true; } catch {}
  const recipients = Array.isArray(plan.recipients) ? [...new Set(plan.recipients)] : [];
  const validTargets = recipients.length > 0 && recipients.length <= 100 && (await Promise.all(recipients.map(async to => {
    const targetRole = await roleOf(to);
    return isWriter(targetRole) && (await visibleProjects(to, targetRole)).has(plan.pid);
  }))).every(Boolean);
  const daysOk = plan.daysOfWeek === undefined ||
    (Array.isArray(plan.daysOfWeek) && plan.daysOfWeek.length <= 7 && plan.daysOfWeek.every(day => Number.isInteger(day) && day >= 0 && day <= 6));
  return (await visibleProjects(uid, role)).has(plan.pid) && String(plan.question || '').trim().length > 0 &&
    ['once', 'daily', 'weekly', 'biweekly', 'monthly'].includes(plan.recurrence) && daysOk &&
    Number.isFinite(plan.nextAt) && plan.nextAt > 0 && zoneOk && validTargets;
}
async function readable(col, uid, role) {
  let out = await allDocs(col);
  if (['none', 'pending', 'removed'].includes(role)) return col === 'members' || col === 'settings' ? out.map(d => d.id === uid ? d : { id: d.id, role: d.role, t: d.t }) : [];
  const vis = await visibleProjects(uid, role);
  switch (col) {
    case 'projects': return out.filter(d => vis.has(d.id));
    case 'inbox': return out.filter(d => d.to === uid);
    case 'dms': return out.filter(d => (d.k || '').split('|').includes(uid));
    case 'settings': return out;
    case 'members': return out.map(d => d.id === uid ? d : { id: d.id, role: d.role, t: d.t, avatar: d.avatar, position: d.position });
    case 'checkinRequests': return Promise.all(out.filter(d => vis.has(d.pid)).map(async request => {
      const plan = await getDoc('checkins', request.planId);
      return role === 'admin' || request.to === uid || plan?.by === uid ? request : null;
    })).then(rows => rows.filter(Boolean));
    case 'checkinAnswers': return Promise.all(out.filter(d => vis.has(d.pid)).map(async answer => {
      const request = await getDoc('checkinRequests', answer.requestId), plan = request && await getDoc('checkins', request.planId);
      return role === 'admin' || request?.to === uid || plan?.by === uid ? answer : null;
    })).then(rows => rows.filter(Boolean));
    case 'checkinComments': return Promise.all(out.filter(d => vis.has(d.pid)).map(async comment => {
      const answer = await getDoc('checkinAnswers', comment.answerId), request = answer && await getDoc('checkinRequests', answer.requestId), plan = request && await getDoc('checkins', request.planId);
      return role === 'admin' || request?.to === uid || plan?.by === uid ? comment : null;
    })).then(rows => rows.filter(Boolean));
    case 'invites': case 'preusers': return role === 'admin' ? out : [];
    default: return out.filter(d => vis.has(d.pid));
  }
}
const COLS = new Set(['projects', 'todos', 'todolists', 'posts', 'chat', 'checkins', 'checkinRequests', 'checkinAnswers', 'checkinComments', 'inbox', 'members', 'settings', 'dms', 'files', 'preusers', 'invites']);
const SCOPED = new Set(['todos', 'todolists', 'posts', 'chat', 'checkins', 'checkinRequests', 'checkinAnswers', 'checkinComments', 'files']);
const SELF_KEYS = new Set(['bm', 'snd', 'avatar', 'theme', 'accent']);
async function allowed(op, col, uid, role, id, cur, data) {
  const w = isWriter(role), adm = role === 'admin', F = 'Forbidden';
  const keys = Object.keys(data || {});
  if (col === 'todos' && (op === 'create' || data.listId !== undefined)) {
    if (typeof data.listId !== 'string' || !data.listId) return F;
    const list = await getDoc('todolists', data.listId);
    if (!list || list.pid !== (op === 'create' ? data.pid : cur?.pid)) return F;
  }
  if (op === 'create' && data.attachments !== undefined &&
      (!Array.isArray(data.attachments) || (await Promise.all(data.attachments.map(async a => !a || !/^[a-f0-9]{40}$/.test(a.aid || '') || !(await ownsUpload(uid, a.aid)))).then(rows => rows.some(Boolean))))) return F;
  switch (col) {
    case 'inbox':
      if (op === 'create') return w && data.to ? null : F;
      if (op === 'delete') return cur && (cur.to === uid || cur.from === uid) ? null : F;
      return op === 'patch' && cur?.to === uid && keys.length === 1 && keys[0] === 'read' && typeof data.read === 'boolean' ? null : F;
    case 'dms':
      if (op === 'create') {
        const participants = String(data.k || '').split('|');
        return w && participants.length === 2 && participants.includes(uid) && participants.includes(data.to) && data.to !== uid ? null : F;
      }
      if (!cur || !(cur.k || '').split('|').includes(uid)) return F;
      if (op === 'delete') return null;
      return op === 'patch' && cur.to === uid && keys.length === 1 && keys[0] === 'seen' && typeof data.seen === 'boolean' ? null : F;
    case 'members':
      if (adm) return null;
      if (op !== 'patch' || id !== uid || !keys.length || !keys.every(k => SELF_KEYS.has(k))) return F;
      if (data.avatar !== undefined && data.avatar !== '' && (!/^[a-f0-9]{40}$/.test(data.avatar) || !(await ownsUpload(uid, data.avatar)))) return F;
      if (data.theme !== undefined && !['system', 'dark', 'light'].includes(data.theme)) return F;
      if (data.accent !== undefined && !['blue', 'green', 'rose', 'amber', 'violet'].includes(data.accent)) return F;
      if (data.position !== undefined) return F;
      return null;
    case 'settings': case 'invites': case 'preusers': return adm ? null : F;
    case 'checkins':
      if (op === 'create' && data.kind === 'plan') {
        return w && await validCheckinPlan(uid, role, data) ? null : F;
      }
      if (cur?.kind === 'plan') {
        if (!adm && cur.by !== uid) return F;
        if (op === 'patch' && keys.every(key => key === 'active')) return typeof data.active === 'boolean' ? null : F;
        const editable = new Set(['question', 'recurrence', 'daysOfWeek', 'recipients', 'nextAt', 'timeZone', 'dayOfMonth']);
        if (op !== 'patch' || !keys.length || !keys.every(key => editable.has(key)) ||
            !(await validCheckinPlan(uid, role, { ...cur, ...data }))) return F;
        return null;
      }
      return F;
    case 'checkinRequests':
      return op === 'patch' && cur?.to === uid && keys.length > 0 && keys.every(k => ['answered', 'answeredAt'].includes(k)) ? null : F;
    case 'checkinAnswers':
      if (op === 'delete' && cur) {
        const request = await getDoc('checkinRequests', cur.requestId), plan = request && await getDoc('checkins', request.planId);
        return adm || cur.by === uid || request?.to === uid || plan?.by === uid ? null : F;
      }
      if (op !== 'create') return cur?.by === uid && op === 'patch' && keys.every(k => ['x', 'attachments'].includes(k)) ? null : F;
      { const request = await getDoc('checkinRequests', data.requestId); return w && request?.to === uid && request.pid === data.pid && !(await allDocs('checkinAnswers')).some(a => a.requestId === data.requestId) ? null : F; }
    case 'checkinComments':
      { const answer = await getDoc('checkinAnswers', op === 'create' ? data.answerId : cur?.answerId), request = answer && await getDoc('checkinRequests', answer.requestId), plan = request && await getDoc('checkins', request.planId);
        if (op === 'create') return w && answer && request && request.pid === data.pid && (adm || request.to === uid || plan?.by === uid) ? null : F;
        return op === 'delete' && cur && (adm || cur.by === uid || request?.to === uid || plan?.by === uid) ? null : F;
      }
    case 'projects':
      if (op === 'create') return w ? null : F;
      if (adm || cur?.by === uid) return null;
      return w && op === 'patch' && cur && (await visibleProjects(uid, role)).has(id) && keys.every(k => k === 'hill') ? null : F;
    default: {
      const vis = await visibleProjects(uid, role);
      if (op === 'create') return w && vis.has(data.pid) ? null : F;
      if (!cur || !vis.has(cur.pid)) return F;
      if (op === 'delete') return adm || cur.by === uid ? null : F;
      if (!w) return F;
      if ((data.pid !== undefined && data.pid !== cur.pid) || (data.by !== undefined && data.by !== cur.by)) return F;
      if (col === 'todos' && Array.isArray(data.log)) {
        const seen = new Set((cur.log || []).map(x => x.cid).filter(Boolean));
        for (const entry of data.log) if (entry?.cid && !seen.has(entry.cid)) {
          if (entry.by !== uid || !Array.isArray(entry.attachments || []) ||
              (await Promise.all((entry.attachments || []).map(async a => !a || !/^[a-f0-9]{40}$/.test(a.aid || '') || !(await ownsUpload(uid, a.aid))))).some(Boolean)) return F;
        }
      }
      return null;
    }
  }
}
const clean = d => { const o = {}; for (const [k, v] of Object.entries(d || {})) if (k !== 'id' && !k.startsWith('_') && v !== undefined) o[k] = v; return o; };

/* ---------- realtime (SSE) ---------- */
const clients = new Set();
const broadcast = col => { for (const r of clients) { try { r.write(`data: ${col}\n\n`); } catch {} } };

/* ---------- optional push + email ---------- */
let webpush = null, mailer = null, vapidPublic = null;
try {
  webpush = (await import('web-push')).default;
  const vf = path.join(DATA, 'vapid.json');
  let keys = env.VAPID_PUBLIC && env.VAPID_PRIVATE ? { publicKey: env.VAPID_PUBLIC, privateKey: env.VAPID_PRIVATE } : !VERCEL && fs.existsSync(vf) ? JSON.parse(fs.readFileSync(vf)) : null;
  if (!keys && !VERCEL) { keys = webpush.generateVAPIDKeys(); fs.writeFileSync(vf, JSON.stringify(keys)); }
  if (keys) {
    webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@example.com', keys.publicKey, keys.privateKey);
    vapidPublic = keys.publicKey;
  } else webpush = null;
} catch (e) { console.warn('web-push disabled:', e.message); webpush = null; }
if (env.SMTP_URL) { try { mailer = (await import('nodemailer')).default.createTransport(env.SMTP_URL); } catch (e) { console.warn('email disabled:', e.message); } }
async function external(n) {
  const u = await store.getUser(n.to); if (!u) return;
  const target = n.target || {}, deepLink = new URL(BASE || 'http://localhost/');
  if (target.type) deepLink.searchParams.set('targetType', target.type);
  if (target.id) deepLink.searchParams.set('targetId', target.id);
  if (target.pid || n.pid) deepLink.searchParams.set('pid', target.pid || n.pid);
  if (target.peer) deepLink.searchParams.set('peer', target.peer);
  if (target.answerId) deepLink.searchParams.set('answerId', target.answerId);
  const notificationUrl = BASE ? deepLink.toString() : deepLink.pathname + deepLink.search;
  if (webpush) for (const r of await store.listPush(u.id)) {
    try { await webpush.sendNotification(JSON.parse(r.sub), JSON.stringify({ title: APP, body: n.text, url: notificationUrl })); }
    catch (e) { if ([404, 410].includes(e.statusCode)) await store.deletePush(r.endpoint); }
  }
  if (mailer && env.EMAIL_NOTIFS !== '0') mailer.sendMail({ from: env.MAIL_FROM || `${APP} <no-reply@localhost>`, to: u.email, subject: `[${APP}] ${String(n.text).slice(0, 80)}`, text: `${n.text}\n\nOpen ${APP}: ${BASE || ''}` }).catch(() => {});
}
async function inbox(to, text, pid = '', from = 'system', k = 'note', target = null) {
  const n = { to, from, k, text: String(text).slice(0, 200), pid, target, t: Date.now(), read: false };
  await putDoc('inbox', nid(), n); broadcast('inbox'); await external(n);
}

function zonedParts(epoch, zone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  return Object.fromEntries(fmt.formatToParts(new Date(epoch)).filter(p => p.type !== 'literal').map(p => [p.type, +p.value]));
}
function zonedEpoch(parts, zone) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  let epoch = target;
  for (let i = 0; i < 3; i++) {
    const current = zonedParts(epoch, zone);
    epoch += target - Date.UTC(current.year, current.month - 1, current.day, current.hour, current.minute, current.second);
  }
  return epoch;
}
function nextCheckinTime(plan, epoch) {
  if (plan.recurrence === 'once') return 0;
  let parts;
  try { parts = zonedParts(epoch, plan.timeZone || 'UTC'); }
  catch (e) { app.log.warn({ timeZone: plan.timeZone }, 'Invalid check-in time zone; using UTC'); parts = zonedParts(epoch, 'UTC'); }
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (plan.recurrence === 'daily') {
    day.setUTCDate(day.getUTCDate() + 1);
    const weekdays = Array.isArray(plan.daysOfWeek) && plan.daysOfWeek.length ? new Set(plan.daysOfWeek) : null;
    for (let i = 0; weekdays && i < 7 && !weekdays.has(day.getUTCDay()); i++) day.setUTCDate(day.getUTCDate() + 1);
  }
  else if (plan.recurrence === 'weekly') day.setUTCDate(day.getUTCDate() + 7);
  else if (plan.recurrence === 'biweekly') day.setUTCDate(day.getUTCDate() + 14);
  else if (plan.recurrence === 'monthly') {
    const wantedDay = plan.dayOfMonth || parts.day;
    day.setUTCDate(1);
    day.setUTCMonth(day.getUTCMonth() + 1);
    day.setUTCDate(Math.min(wantedDay, new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate()));
  } else return 0;
  return zonedEpoch({ ...parts, year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() }, plan.timeZone || 'UTC');
}
async function sweepCheckins() {
  const now = Date.now(), projects = new Map((await allDocs('projects')).map(p => [p.id, p]));
  let changedPlans = false, createdRequests = false;
  for (const plan of await allDocs('checkins')) {
    if (plan.kind !== 'plan' || !plan.active || !plan.nextAt || plan.nextAt > now) continue;
    const project = projects.get(plan.pid);
    if (!project || project.trashed || project.archived) continue;
    let nextAt = plan.nextAt, generated = 0;
    while (nextAt && nextAt <= now && generated < 100) {
      for (const to of plan.recipients || []) {
        const role = await roleOf(to), allowedProjects = await visibleProjects(to, role);
        if (!(await store.getUser(to)) || !isWriter(role) || !allowedProjects.has(plan.pid)) continue;
        const id = crypto.createHash('sha256').update(`${plan.id}:${to}:${nextAt}`).digest('hex').slice(0, 40);
        if (!(await getDoc('checkinRequests', id))) {
          await putDoc('checkinRequests', id, { kind: 'request', pid: plan.pid, planId: plan.id, question: plan.question, to, scheduledAt: nextAt, answered: false, t: now });
          await inbox(to, `Check-in requested: ${plan.question}`, plan.pid, 'system', 'checkin', { type: 'checkinRequest', id, pid: plan.pid });
          createdRequests = true;
        }
      }
      generated++;
      nextAt = nextCheckinTime(plan, nextAt);
    }
    const { id, ...rest } = plan;
    await putDoc('checkins', id, { ...rest, nextAt, active: plan.recurrence === 'once' ? false : plan.active });
    changedPlans = true;
  }
  if (changedPlans) broadcast('checkins');
  if (createdRequests) broadcast('checkinRequests');
}

/* ---------- app ---------- */
const app = Fastify({ logger: { level: env.LOG_LEVEL || 'info' }, trustProxy: env.TRUST_PROXY === 'true', bodyLimit: 1024 * 1024 });
await app.register(cookie);
app.removeContentTypeParser('text/plain');
app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD }, (req, body, done) => done(null, body));
app.addHook('onRequest', async (req, reply) => {
  if (!['GET', 'HEAD'].includes(req.method) && req.url.startsWith('/api/') && req.headers['x-requested-with'] !== 'fetch') return reply.code(403).send({ error: 'Bad request' });
  const t = req.cookies?.sid;
  if (t) req.uid = await store.getSessionUser(sha(t), Date.now()) || undefined;
});
app.addHook('onSend', async (req, reply) => {
  reply.header('x-content-type-options', 'nosniff').header('x-frame-options', 'DENY').header('referrer-policy', 'same-origin');
});
const need = (req, reply) => { if (!req.uid) { reply.code(401).send({ error: 'Not signed in' }); return false; } return true; };
const bad = (reply, msg, code = 400) => reply.code(code).send({ error: msg });

app.get('/healthz', async () => ({ ok: true }));

/* auth */
app.post('/api/signup', async (req, reply) => {
  if (throttle(req)) return bad(reply, 'Too many attempts. Try again later.', 429);
  const { name, email, password, code } = req.body || {};
  const em = String(email || '').trim().toLowerCase(), nm = String(name || '').trim();
  if (nm.length < 2 || nm.length > 80) return bad(reply, 'Enter your full name');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return bad(reply, 'Enter a valid email');
  if (String(password || '').length < 8) return bad(reply, 'Password must be at least 8 characters');
  if (await store.getUserByEmail(em)) return bad(reply, 'An account with this email already exists', 409);
  const first = (await store.userCount()) === 0;
  const id = nid(); let role;
  if (first) role = 'admin';
  else {
    const c = String(code || '').toUpperCase().replace(/\s/g, '');
    const inv = c && (await allDocs('invites')).find(i => i.code === c);
    const pre = (await allDocs('preusers')).find(p => (p.email || '').toLowerCase() === em);
    if (inv && !inv.revoked && (inv.uses || 0) < (inv.max || 1) && (!inv.exp || inv.exp > Date.now())) {
      role = inv.role; await putDoc('invites', inv.id, { ...strip(inv), uses: (inv.uses || 0) + 1, usedBy: [...(inv.usedBy || []), id] }); broadcast('invites');
    } else if (pre) { role = pre.role; await delDoc('preusers', pre.id); }
    else if ((await getDoc('settings', 'main'))?.approval) role = 'pending';
    else return bad(reply, 'A valid invite code is required', 403);
  }
  const created = Date.now();
  await store.createUser({ id, name: nm, email: em, pw: hashPw(password), owner: first, created }, { role, t: created, position: '' });
  broadcast('members');
  if (role === 'pending') for (const a of (await allDocs('members')).filter(m => m.role === 'admin')) await inbox(a.id, `${nm} requested access`, '', id);
  await startSession(reply, id); return { ok: true };
});
app.post('/api/login', async (req, reply) => {
  if (throttle(req)) return bad(reply, 'Too many attempts. Try again later.', 429);
  const { email, password } = req.body || {};
  const u = await store.getUserByEmail(String(email || '').trim().toLowerCase());
  if (!u || !checkPw(String(password || ''), u.pw)) return bad(reply, 'Wrong email or password', 401);
  await startSession(reply, u.id); return { ok: true };
});
app.post('/api/logout', async (req, reply) => {
  const t = req.cookies?.sid; if (t) await store.deleteSession(sha(t));
  reply.clearCookie('sid', { path: '/' }); return { ok: true };
});
app.get('/api/me', async (req, reply) => {
  if (!need(req, reply)) return; const u = await store.getUser(req.uid);
  return { id: u.id, name: u.name, email: u.email, owner: !!u.owner };
});
app.post('/api/password', async (req, reply) => {
  if (!need(req, reply)) return; const u = await store.getUser(req.uid), { old, new: nw } = req.body || {};
  if (!checkPw(String(old || ''), u.pw)) return bad(reply, 'Current password is wrong', 401);
  if (String(nw || '').length < 8) return bad(reply, 'New password must be at least 8 characters');
  await store.updatePassword(u.id, hashPw(nw));
  const keep = sha(req.cookies.sid); await store.deleteOtherSessions(u.id, keep); return { ok: true };
});
app.post('/api/admin/users', async (req, reply) => {
  if (!need(req, reply)) return; if (await roleOf(req.uid) !== 'admin') return bad(reply, 'Forbidden', 403);
  const { name, email, role, position = '' } = req.body || {}, em = String(email || '').trim().toLowerCase(), nm = String(name || '').trim();
  if (nm.length < 2) return bad(reply, 'Enter the full name');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return bad(reply, 'Enter a valid email');
  if (!['admin', 'member', 'viewer'].includes(role)) return bad(reply, 'Invalid role');
  if (await store.getUserByEmail(em)) return bad(reply, 'An account with this email already exists', 409);
  const id = nid(), pw = tempPw();
  const created = Date.now();
  await store.createUser({ id, name: nm, email: em, pw: hashPw(pw), owner: false, created }, { role, t: created, position: String(position).trim().slice(0, 100) });
  broadcast('members');
  if (mailer) mailer.sendMail({ from: env.MAIL_FROM || `${APP} <no-reply@localhost>`, to: em, subject: `Your ${APP} account`, text: `Hello ${nm},\n\nAn account was created for you on ${APP}.\nAddress: ${BASE}\nEmail: ${em}\nTemporary password: ${pw}\n\nPlease change it after you log in (⚙ Settings).` }).catch(() => {});
  return { id, password: pw };
});
app.post('/api/admin/users/import', async (req, reply) => {
  if (!need(req, reply)) return;
  if (await roleOf(req.uid) !== 'admin') return bad(reply, 'Forbidden', 403);
  if (!Buffer.isBuffer(req.body) || !req.body.length) return bad(reply, 'Upload an .xlsx workbook');
  if (req.body.length > 5 * 1024 * 1024) return bad(reply, 'Workbook exceeds the 5 MB import limit');
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(req.body); }
  catch { return bad(reply, 'Could not read the workbook. Upload a valid .xlsx file.'); }
  const sheet = workbook.worksheets[0];
  if (!sheet) return bad(reply, 'Workbook has no worksheets');
  const normalize = value => String(value || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  const headers = new Map();
  sheet.getRow(1).eachCell((cell, column) => headers.set(normalize(cell.text), column));
  const column = (...names) => names.map(normalize).map(name => headers.get(name)).find(Boolean);
  const columns = {
    name: column('Full Name', 'Name'),
    email: column('Email'),
    password: column('Temporary Password', 'Password'),
    role: column('Role'),
    position: column('Position', 'Job Title'),
  };
  if (!columns.name || !columns.email || !columns.role) return bad(reply, 'Include header columns Full Name, Email, and Role');
  if (sheet.rowCount > 501) return bad(reply, 'Import is limited to 500 users per workbook');
  const created = [], rejected = [], seen = new Set();
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const value = key => columns[key] ? String(row.getCell(columns[key]).text || '').trim() : '';
    const name = value('name'), email = value('email').toLowerCase(), role = value('role').toLowerCase();
    if (!name && !email && !role) continue;
    let error = '';
    if (name.length < 2 || name.length > 80) error = 'Full name must be 2–80 characters';
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) error = 'Enter a valid email address';
    else if (!['admin', 'member', 'viewer'].includes(role)) error = 'Role must be admin, member, or viewer';
    else if (seen.has(email) || await store.getUserByEmail(email)) error = 'Email already exists';
    const password = value('password') || tempPw();
    if (!error && password.length < 8) error = 'Temporary password must be at least 8 characters';
    if (error) { rejected.push({ row: rowNumber, email, error }); continue; }
    seen.add(email);
    const id = nid(), position = value('position').slice(0, 100), createdAt = Date.now();
    try {
      await store.createUser({ id, name, email, pw: hashPw(password), owner: false, created: createdAt }, { role, t: createdAt, position });
      created.push({ row: rowNumber, id, name, email, role, position, password });
      if (mailer) mailer.sendMail({ from: env.MAIL_FROM || `${APP} <no-reply@localhost>`, to: email, subject: `Your ${APP} account`, text: `Hello ${name},\n\nYour account is ready.\nAddress: ${BASE}\nEmail: ${email}\nTemporary password: ${password}\n\nPlease change it after logging in.` }).catch(() => {});
    } catch (error) {
      if (error.code !== '23505' && !/UNIQUE constraint failed/.test(error.message || '')) throw error;
      rejected.push({ row: rowNumber, email, error: 'Email already exists' });
    }
  }
  if (created.length) broadcast('members');
  return { created, rejected };
});
app.get('/api/admin/users/import-template', async (req, reply) => {
  if (!need(req, reply)) return;
  if (await roleOf(req.uid) !== 'admin') return bad(reply, 'Forbidden', 403);
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Users');
  sheet.addRow(['Full Name', 'Email', 'Temporary Password', 'Role', 'Position']);
  sheet.getRow(1).font = { bold: true };
  sheet.addRow(['Example Person', 'person@example.com', '', 'member', 'Project Manager']);
  sheet.columns = [{ width: 26 }, { width: 32 }, { width: 24 }, { width: 14 }, { width: 24 }];
  const file = Buffer.from(await workbook.xlsx.writeBuffer());
  return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header('content-disposition', 'attachment; filename="followup-users-template.xlsx"').send(file);
});
app.post('/api/admin/users/:id/reset', async (req, reply) => {
  if (!need(req, reply)) return; if (await roleOf(req.uid) !== 'admin') return bad(reply, 'Forbidden', 403);
  const u = await store.getUser(req.params.id); if (!u) return bad(reply, 'Not found', 404);
  const pw = tempPw(); await store.updatePassword(u.id, hashPw(pw)); await store.deleteUserSessions(u.id);
  return { password: pw };
});
app.get('/api/profiles', async (req, reply) => {
  if (!need(req, reply)) return; const out = { system: { name: APP } };
  for (const id of String(req.query.ids || '').split(',').filter(Boolean).slice(0, 500)) { const u = await store.getUser(id), member = await getDoc('members', id); if (u) out[id] = { name: u.name, avatar: member?.avatar || '', position: member?.position || '' }; }
  return out;
});
app.get('/api/search', async (req, reply) => {
  if (!need(req, reply)) return; const q = String(req.query.q || '').toLowerCase();
  return (await store.listUsers()).filter(u => !q || u.name.toLowerCase().includes(q)).slice(0, 8);
});

/* generic document API (all permission checks happen here, on the server) */
const colOk = (req, reply) => { if (!need(req, reply)) return false; if (!COLS.has(req.params.col)) { bad(reply, 'Unknown collection', 404); return false; } return true; };
app.get('/api/c/:col', async (req, reply) => {
  if (!colOk(req, reply)) return; const { ob, dir, lim } = req.query, role = await roleOf(req.uid);
  let out = await readable(req.params.col, req.uid, role);
  if (ob) out.sort((a, b) => (a[ob] > b[ob] ? 1 : a[ob] < b[ob] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
  return lim ? out.slice(0, +lim) : out;
});
app.post('/api/c/:col', async (req, reply) => {
  if (!colOk(req, reply)) return; const { col } = req.params, role = await roleOf(req.uid); let d = clean(req.body);
  const e = await allowed('create', col, req.uid, role, null, null, d); if (e) return bad(reply, e, 403);
  if (col === 'projects' || SCOPED.has(col)) d.by = req.uid;
  if (col === 'checkinAnswers' || col === 'checkinComments') d.t = Date.now();
  if (col === 'inbox') { if (!(await store.getUser(d.to))) return bad(reply, 'Recipient not found', 404); d.from = req.uid; d.read = false; d.t = Date.now(); }
  if (col === 'dms') { if (!(await store.getUser(d.to))) return bad(reply, 'Recipient not found', 404); d.from = req.uid; d.seen = false; d.t = Date.now(); }
  const id = nid(); await putDoc(col, id, d); broadcast(col); if (col === 'inbox') await external(d);
  if (col === 'checkins' && d.kind === 'plan') setTimeout(() => sweepCheckins().catch(e => app.log.error(e)), 0);
  return { id };
});
const mutate = op => async (req, reply) => {
  if (!colOk(req, reply)) return; const { col, id } = req.params, role = await roleOf(req.uid), cur = await getDoc(col, id);
  const d = op === 'delete' ? {} : clean(req.body);
  if (op !== 'put' && !cur && !(col === 'members' || col === 'settings')) return bad(reply, 'Not found', 404);
  const e = await allowed(op, col, req.uid, role, id, cur, d); if (e) return bad(reply, e, 403);
  if (op === 'delete') {
    await delDoc(col, id);
    if (col === 'checkinAnswers') {
      for (const comment of await allDocs('checkinComments')) if (comment.answerId === id) await delDoc('checkinComments', comment.id);
      const request = await getDoc('checkinRequests', cur.requestId);
      if (request) await putDoc('checkinRequests', cur.requestId, { ...request, answered: false, answeredAt: null });
    }
  } else await putDoc(col, id, op === 'put' ? d : { ...(cur || {}), ...d });
  if (col === 'members' && op === 'patch' && d.role === 'removed') await store.deleteUserSessions(id);
  broadcast(col); return { ok: true };
};
app.put('/api/c/:col/:id', mutate('put')); app.patch('/api/c/:col/:id', mutate('patch')); app.delete('/api/c/:col/:id', mutate('delete'));

/* realtime stream */
app.get('/api/stream', (req, reply) => {
  if (!need(req, reply)) return; reply.hijack(); const r = reply.raw;
  r.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  r.write('retry: 3000\n\n'); clients.add(r);
  const t = setInterval(() => { try { r.write('data: __heartbeat__\n\n'); } catch {} }, 25000);
  r.on('close', () => { clearInterval(t); clients.delete(r); });
});

/* files */
const FID = /^[a-f0-9]{40}$/, UP = id => path.join(DATA, 'uploads', id);
async function ownsUpload(uid, id) {
  if (!FID.test(id)) return false;
  return (await store.getUpload(id))?.by === uid;
}
app.post('/api/upload', async (req, reply) => {
  if (!need(req, reply)) return; if (!isWriter(await roleOf(req.uid))) return bad(reply, 'Forbidden', 403);
  const buf = req.body; if (!Buffer.isBuffer(buf) || !buf.length) return bad(reply, 'Empty file');
  const id = crypto.randomBytes(20).toString('hex'), name = decodeURIComponent(String(req.headers['x-filename'] || 'file')).slice(0, 200);
  const type = String(req.headers['content-type'] || 'application/octet-stream');
  const pathname = VERCEL
    ? (await blobStore.put(id, buf, { access: 'private', addRandomSuffix: false, contentType: type })).pathname
    : id;
  if (!VERCEL) fs.writeFileSync(UP(id), buf);
  await store.putUpload({ id, by: req.uid, name, type, size: buf.length, pathname });
  return { id, name, type, sizeBytes: buf.length };
});
app.get('/_blob/:id', async (req, reply) => {
  if (!need(req, reply)) return; const id = req.params.id; if (!FID.test(id)) return bad(reply, 'Not found', 404);
  const meta = await store.getUpload(id); if (!meta) return bad(reply, 'Not found', 404);
  const role = await roleOf(req.uid), fileDocs = await allDocs('files'), f = fileDocs.find(x => x.aid === id);
  const contains = value => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(contains);
    if (value.aid === id) return true;
    return Object.values(value).some(contains);
  };
  const scoped = ['todos', 'todolists', 'posts', 'chat', 'checkins', 'checkinRequests', 'checkinAnswers', 'checkinComments', 'files'];
  const attached = (await Promise.all(scoped.map(async col => (await readable(col, req.uid, role)).some(contains)))).some(Boolean);
  const privateAttached = (await Promise.all(['inbox', 'dms'].map(async col => (await readable(col, req.uid, role)).some(contains)))).some(Boolean);
  const profileAttached = role !== 'none' && role !== 'removed' && (await allDocs('members')).some(m => m.avatar === id);
  const visible = await visibleProjects(req.uid, role);
  const ok = attached || privateAttached || profileAttached || f && visible.has(f.pid) || meta.by === req.uid || role === 'admin';
  if (!ok) return bad(reply, 'Forbidden', 403);
  const safe = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(meta.type);
  let content;
  if (VERCEL) {
    const result = await blobStore.get(meta.pathname, { access: 'private' });
    if (!result || result.statusCode !== 200) return bad(reply, 'Not found', 404);
    content = Readable.fromWeb(result.stream);
  } else {
    if (!fs.existsSync(UP(id))) return bad(reply, 'Not found', 404);
    content = fs.createReadStream(UP(id));
  }
  return reply.header('content-type', safe ? meta.type : 'application/octet-stream')
    .header('x-content-type-options', 'nosniff')
    .header('content-disposition', `${safe ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`).send(content);
});
app.delete('/api/blob/:id', async (req, reply) => {
  if (!need(req, reply)) return; const id = req.params.id; if (!FID.test(id)) return { ok: true };
  const meta = await store.getUpload(id); if (!meta) return { ok: true };
  if (meta.by !== req.uid && await roleOf(req.uid) !== 'admin') return bad(reply, 'Forbidden', 403);
  if (VERCEL) await blobStore.del(meta.pathname, { access: 'private' });
  else fs.rmSync(UP(id), { force: true });
  await store.deleteUpload(id); return { ok: true };
});

/* push subscriptions */
app.get('/api/push/key', async (req, reply) => { if (!need(req, reply)) return; return vapidPublic ? { key: vapidPublic } : bad(reply, 'Push not available', 404); });
app.post('/api/push/sub', async (req, reply) => {
  if (!need(req, reply)) return; const s = req.body?.subscription; if (!s?.endpoint) return bad(reply, 'Bad subscription');
  await store.putPush(s.endpoint, req.uid, JSON.stringify(s)); return { ok: true };
});

/* automatic follow-up reminders (runs on the server, no admin needs to be online) */
async function sweep() {
  const now = Date.now(), today = new Date().toISOString().slice(0, 10), projs = new Set((await allDocs('projects')).filter(p => !p.trashed).map(p => p.id));
  for (const t of await allDocs('todos')) {
    if (t.trashed || t.done || !t.to || !projs.has(t.pid) || !(await store.getUser(t.to))) continue;
    const idle = (now - (t.last || now)) / DAY, od = t.due && t.due < today ? (Date.parse(today) - Date.parse(t.due)) / DAY : 0;
    if (!(od > 0 || idle >= 2) || (t.nudges || []).some(n => now - n.t < DAY)) continue;
    const why = [od > 0 && `Overdue ${od}d`, idle >= 2 && `No update ${Math.floor(idle)}d`].filter(Boolean).join(', ');
    const { id, ...rest } = t; await putDoc('todos', id, { ...rest, nudges: [...(t.nudges || []), { by: 'system', t: now, auto: 1 }].slice(-10) });
    await inbox(t.to, `Auto-reminder: “${t.title}” needs an update (${why})`, t.pid, 'system', 'note', { type: 'todo', id: t.id, pid: t.pid });
  }
  broadcast('todos');
}
if (!VERCEL) {
  setInterval(() => sweep().catch(e => app.log.error(e)), (+env.SWEEP_MINUTES || 60) * 60e3); setTimeout(() => sweep().catch(e => app.log.error(e)), 15e3);
  setInterval(() => sweepCheckins().catch(e => app.log.error(e)), 60e3); setTimeout(() => sweepCheckins().catch(e => app.log.error(e)), 5e3);
  setInterval(() => store.deleteExpiredSessions(Date.now()).catch(e => app.log.error(e)), 6 * 3600e3);
}
app.get('/api/cron', async (req, reply) => {
  if (!VERCEL || !env.CRON_SECRET || req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) return bad(reply, 'Forbidden', 403);
  await sweep();
  await sweepCheckins();
  await store.deleteExpiredSessions(Date.now());
  return { ok: true };
});
app.get('/api/config', async () => ({ polling: VERCEL }));

await app.register(fstatic, { root: path.join(__dir, 'public'), prefix: '/' });
const stop = async () => { await app.close(); await store.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
await app.listen({ port: PORT, host: HOST });
console.log(`${APP} running on http://localhost:${PORT} (${store.isPostgres ? 'Postgres' : `data: ${DATA}`})`);
