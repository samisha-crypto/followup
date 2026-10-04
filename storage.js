import fs from 'node:fs';
import path from 'node:path';

export async function createStorage({ dataDir, databaseUrl }) {
  if (databaseUrl) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,pw TEXT NOT NULL,owner BOOLEAN NOT NULL DEFAULT FALSE,created BIGINT);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,uid TEXT NOT NULL,exp BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS docs(col TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,seq BIGSERIAL,PRIMARY KEY(col,id));
      CREATE INDEX IF NOT EXISTS docs_col_idx ON docs(col,seq);
      CREATE TABLE IF NOT EXISTS push(endpoint TEXT PRIMARY KEY,uid TEXT NOT NULL,sub TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,by_user TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,size BIGINT NOT NULL,pathname TEXT NOT NULL);
    `);
    return {
      isPostgres: true,
      getDoc: async (col, id) => {
        const { rows } = await pool.query('SELECT data FROM docs WHERE col=$1 AND id=$2', [col, id]);
        return rows[0] ? JSON.parse(rows[0].data) : null;
      },
      allDocs: async col => {
        const { rows } = await pool.query('SELECT id,data FROM docs WHERE col=$1 ORDER BY seq', [col]);
        return rows.map(row => ({ id: row.id, ...JSON.parse(row.data) }));
      },
      putDoc: async (col, id, data) => pool.query(
        'INSERT INTO docs(col,id,data) VALUES($1,$2,$3) ON CONFLICT(col,id) DO UPDATE SET data=EXCLUDED.data',
        [col, id, JSON.stringify(data)],
      ),
      deleteDoc: async (col, id) => pool.query('DELETE FROM docs WHERE col=$1 AND id=$2', [col, id]),
      getUser: async id => (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0] || null,
      getUserByEmail: async email => (await pool.query('SELECT * FROM users WHERE email=$1', [email])).rows[0] || null,
      listUsers: async () => (await pool.query('SELECT id,name,email FROM users ORDER BY name')).rows,
      userCount: async () => Number((await pool.query('SELECT COUNT(*) AS count FROM users')).rows[0].count),
      createUser: async (user, member) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('INSERT INTO users(id,name,email,pw,owner,created) VALUES($1,$2,$3,$4,$5,$6)',
            [user.id, user.name, user.email, user.pw, user.owner, user.created]);
          await client.query('INSERT INTO docs(col,id,data) VALUES($1,$2,$3) ON CONFLICT(col,id) DO UPDATE SET data=EXCLUDED.data',
            ['members', user.id, JSON.stringify(member)]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      updatePassword: async (id, passwordHash) => pool.query('UPDATE users SET pw=$1 WHERE id=$2', [passwordHash, id]),
      saveSession: async (token, uid, exp) => pool.query('INSERT INTO sessions(token,uid,exp) VALUES($1,$2,$3)', [token, uid, exp]),
      getSessionUser: async (token, now) => (await pool.query('SELECT uid FROM sessions WHERE token=$1 AND exp>$2', [token, now])).rows[0]?.uid || null,
      deleteSession: async token => pool.query('DELETE FROM sessions WHERE token=$1', [token]),
      deleteOtherSessions: async (uid, keep) => pool.query('DELETE FROM sessions WHERE uid=$1 AND token<>$2', [uid, keep]),
      deleteUserSessions: async uid => pool.query('DELETE FROM sessions WHERE uid=$1', [uid]),
      deleteExpiredSessions: async now => pool.query('DELETE FROM sessions WHERE exp<$1', [now]),
      listPush: async uid => (await pool.query('SELECT endpoint,sub FROM push WHERE uid=$1', [uid])).rows,
      putPush: async (endpoint, uid, sub) => pool.query(
        'INSERT INTO push(endpoint,uid,sub) VALUES($1,$2,$3) ON CONFLICT(endpoint) DO UPDATE SET uid=EXCLUDED.uid,sub=EXCLUDED.sub',
        [endpoint, uid, sub],
      ),
      deletePush: async endpoint => pool.query('DELETE FROM push WHERE endpoint=$1', [endpoint]),
      putUpload: async meta => pool.query(
        'INSERT INTO uploads(id,by_user,name,type,size,pathname) VALUES($1,$2,$3,$4,$5,$6)',
        [meta.id, meta.by, meta.name, meta.type, meta.size, meta.pathname],
      ),
      getUpload: async id => (await pool.query('SELECT id,by_user AS by,name,type,size,pathname FROM uploads WHERE id=$1', [id])).rows[0] || null,
      deleteUpload: async id => pool.query('DELETE FROM uploads WHERE id=$1', [id]),
      close: () => pool.end(),
    };
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'followup.db');
  let db;
  const version = process.versions.node.split('.').map(Number);
  const preferBuiltIn = version[0] > 22 || (version[0] === 22 && version[1] >= 13);
  const loadBetterSqlite = async () => {
    try { db = new (await import('better-sqlite3')).default(dbFile); }
    catch (error) { console.warn('better-sqlite3 unavailable (' + String(error.message).split('\n')[0] + ')'); }
  };
  if (process.env.FORCE_NODE_SQLITE !== '1' && !preferBuiltIn) await loadBetterSqlite();
  if (!db) {
    try { db = new (await import('node:sqlite')).DatabaseSync(dbFile); }
    catch {
      if (process.env.FORCE_NODE_SQLITE !== '1' && preferBuiltIn) await loadBetterSqlite();
      if (!db) throw new Error('No SQLite engine available. Install Node.js 22.13+ or fix better-sqlite3.');
    }
  }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,pw TEXT NOT NULL,owner INTEGER DEFAULT 0,created INTEGER);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,uid TEXT NOT NULL,exp INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS docs(col TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(col,id));
    CREATE TABLE IF NOT EXISTS push(endpoint TEXT PRIMARY KEY,uid TEXT NOT NULL,sub TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,by_user TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,size INTEGER NOT NULL,pathname TEXT NOT NULL);
  `);
  const stmts = {
    getDoc: db.prepare('SELECT data FROM docs WHERE col=? AND id=?'),
    allDocs: db.prepare('SELECT id,data FROM docs WHERE col=? ORDER BY rowid'),
    putDoc: db.prepare('INSERT INTO docs(col,id,data) VALUES(?,?,?) ON CONFLICT(col,id) DO UPDATE SET data=excluded.data'),
    deleteDoc: db.prepare('DELETE FROM docs WHERE col=? AND id=?'),
    getUser: db.prepare('SELECT * FROM users WHERE id=?'),
    getUserByEmail: db.prepare('SELECT * FROM users WHERE email=?'),
    listUsers: db.prepare('SELECT id,name,email FROM users ORDER BY name'),
    createUser: (user, member) => {
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(user.id, user.name, user.email, user.pw, user.owner ? 1 : 0, user.created);
        stmts.putDoc.run('members', user.id, JSON.stringify(member));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    updatePassword: db.prepare('UPDATE users SET pw=? WHERE id=?'),
    saveSession: db.prepare('INSERT INTO sessions VALUES(?,?,?)'),
    getSessionUser: db.prepare('SELECT uid FROM sessions WHERE token=? AND exp>?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token=?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE uid=? AND token<>?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE uid=?'),
    deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE exp<?'),
    listPush: db.prepare('SELECT endpoint,sub FROM push WHERE uid=?'),
    putPush: db.prepare('INSERT OR REPLACE INTO push VALUES(?,?,?)'),
    deletePush: db.prepare('DELETE FROM push WHERE endpoint=?'),
    putUpload: db.prepare('INSERT INTO uploads VALUES(?,?,?,?,?,?)'),
    getUpload: db.prepare('SELECT id,by_user AS by,name,type,size,pathname FROM uploads WHERE id=?'),
    deleteUpload: db.prepare('DELETE FROM uploads WHERE id=?'),
  };
  return {
    isPostgres: false,
    getDoc: async (col, id) => { const row = stmts.getDoc.get(col, id); return row ? JSON.parse(row.data) : null; },
    allDocs: async col => stmts.allDocs.all(col).map(row => ({ id: row.id, ...JSON.parse(row.data) })),
    putDoc: async (col, id, data) => stmts.putDoc.run(col, id, JSON.stringify(data)),
    deleteDoc: async (col, id) => stmts.deleteDoc.run(col, id),
    getUser: async id => stmts.getUser.get(id) || null,
    getUserByEmail: async email => stmts.getUserByEmail.get(email) || null,
    listUsers: async () => stmts.listUsers.all(),
    userCount: async () => db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
    createUser: async (user, member) => stmts.createUser(user, member),
    updatePassword: async (id, hash) => stmts.updatePassword.run(hash, id),
    saveSession: async (token, uid, exp) => stmts.saveSession.run(token, uid, exp),
    getSessionUser: async (token, now) => stmts.getSessionUser.get(token, now)?.uid || null,
    deleteSession: async token => stmts.deleteSession.run(token),
    deleteOtherSessions: async (uid, keep) => stmts.deleteOtherSessions.run(uid, keep),
    deleteUserSessions: async uid => stmts.deleteUserSessions.run(uid),
    deleteExpiredSessions: async now => stmts.deleteExpiredSessions.run(now),
    listPush: async uid => stmts.listPush.all(uid),
    putPush: async (endpoint, uid, sub) => stmts.putPush.run(endpoint, uid, sub),
    deletePush: async endpoint => stmts.deletePush.run(endpoint),
    putUpload: async meta => stmts.putUpload.run(meta.id, meta.by, meta.name, meta.type, meta.size, meta.pathname),
    getUpload: async id => stmts.getUpload.get(id) || null,
    deleteUpload: async id => stmts.deleteUpload.run(id),
    close: async () => db.close(),
  };
}
