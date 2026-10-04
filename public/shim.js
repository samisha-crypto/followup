// Adapter: gives the existing FollowUp app the same `claude.use('db'|'user'|'assets')` API it was written for,
// but backed by this server (real accounts, server-side permissions).
(() => {
  const J = (method, url, body) => fetch(url, {
    method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async r => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || r.statusText); e.code = r.status; throw e; }
    return j;
  });
  let ME = null, es = null, streamStarted = false, pollTimer = null, lastStreamEvent = 0;
  const subs = new Map();
  const refreshAll = () => new Set([...subs.values()].flatMap(a => [...a])).forEach(f => f());
  const stopPolling = () => { if (pollTimer) clearInterval(pollTimer); pollTimer = null; };
  const startPolling = () => {
    if (pollTimer) return;
    refreshAll();
    pollTimer = setInterval(refreshAll, 5000);
  };
  async function stream() {
    if (streamStarted) return;
    streamStarted = true;
    try {
      const { polling } = await J('GET', '/api/config');
      if (polling) {
        startPolling();
        return;
      }
    } catch (e) { startPolling(); return; }
    es = new EventSource('/api/stream');
    es.onopen = () => {
      lastStreamEvent = Date.now();
      stopPolling();
      refreshAll();
    };
    es.onmessage = ev => {
      lastStreamEvent = Date.now();
      if (ev.data === '__heartbeat__') return;
      (subs.get(ev.data) || []).forEach(f => f());
    };
    es.onerror = () => startPolling();
    setInterval(() => {
      if (!document.hidden && lastStreamEvent && Date.now() - lastStreamEvent > 45000) startPolling();
    }, 10000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
  class Snap {
    constructor(list, prev) {
      this.docs = list.map(o => { const { id, ...rest } = o; return { id, data: () => rest }; });
      this._prev = new Set(prev || []);
    }
    docChanges() { return this.docs.filter(d => !this._prev.has(d.id)).map(doc => ({ type: 'added', doc })); }
  }
  const ref = (col, id) => ({
    id,
    set: d => J('PUT', `/api/c/${col}/${id}`, d),
    update: d => J('PATCH', `/api/c/${col}/${id}`, d),
    delete: () => J('DELETE', `/api/c/${col}/${id}`),
  });
  function query(col, o = {}) {
    return {
      orderBy: (f, d) => query(col, { ...o, ob: f, dir: d || 'asc' }),
      limit: n => query(col, { ...o, lim: n }),
      doc: id => ref(col, id),
      add: async d => ref(col, (await J('POST', `/api/c/${col}`, d)).id),
      onSnapshot(cb) {
        let prev = [], alive = true, busy = false, again = false;
        const run = async () => {
          if (!alive) return; if (busy) { again = true; return; } busy = true;
          try {
            const l = await J('GET', `/api/c/${col}?` + new URLSearchParams({ ob: o.ob || '', dir: o.dir || '', lim: o.lim || '' }));
            cb(new Snap(l, prev)); prev = l.map(x => x.id);
          } catch (e) { if (e.code === 401) location.reload(); }
          busy = false; if (again) { again = false; run(); }
        };
        run(); stream();
        const a = subs.get(col) || new Set(); a.add(run); subs.set(col, a);
        return () => { alive = false; a.delete(run); if (!a.size) subs.delete(col); };
      },
    };
  }
  window.claude = {
    use: async name => {
      if (name === 'db') return { collection: c => query(c) };
      if (name === 'user') return {
        id: async () => { try { ME = ME || await J('GET', '/api/me'); } catch { return null; } return ME.id; },
        isOwner: async () => !!(ME && ME.owner),
        me: async () => ME,
        profiles: async ids => J('GET', '/api/profiles?ids=' + encodeURIComponent(ids.join(','))),
        search: async q => J('GET', '/api/search?q=' + encodeURIComponent(q)),
      };
      if (name === 'assets') return {
        upload: async f => {
          const r = await fetch('/api/upload', { method: 'POST', credentials: 'same-origin',
            headers: { 'x-requested-with': 'fetch', 'x-filename': encodeURIComponent(f.name), 'content-type': f.type || 'application/octet-stream' }, body: f });
          const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Upload failed'); return j;
        },
        delete: id => J('DELETE', '/api/blob/' + id),
      };
      return null;
    },
  };
})();
