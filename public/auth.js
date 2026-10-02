// Login / signup / logout / password / admin user creation / web-push subscription.
(() => {
  const $ = s => document.querySelector(s);
  const post = (u, b) => fetch(u, { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify(b || {}) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Request failed'); return j; });
  const err = m => { const e = $('#aerr'); if (e) e.textContent = m; else alert(m); };
  async function subscribePush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
      const k = await fetch('/api/push/key').then(r => r.ok ? r.json() : null); if (!k) return false;
      const reg = await navigator.serviceWorker.register('/sw.js');
      if (await Notification.requestPermission() !== 'granted') return false;
      const b = k.key.replace(/-/g, '+').replace(/_/g, '/'), raw = atob(b + '='.repeat((4 - b.length % 4) % 4));
      const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, c => c.charCodeAt(0)) });
      await post('/api/push/sub', { subscription: sub }); return true;
    } catch { return false; }
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return; const a = b.dataset.act;
    try {
      if (a === 'login') { await post('/api/login', { email: $('#ae').value, password: $('#ap').value }); location.reload(); }
      else if (a === 'signup') { await post('/api/signup', { name: $('#an').value, email: $('#ae').value, password: $('#ap').value, code: $('#ac').value }); location.reload(); }
      else if (a === 'logout') { await post('/api/logout'); location.reload(); }
      else if (a === 'chpw') { await post('/api/password', { old: $('#pw0').value, new: $('#pw1').value }); alert('Password updated'); $('#pw0').value = $('#pw1').value = ''; }
      else if (a === 'uadd2') {
        const r = await post('/api/admin/users', { name: $('#un').value, email: $('#ue').value, role: $('#ur').value, position: $('#up').value });
        const t = $('#tp'); t.style.display = 'block';
        t.value = `Account created.\nEmail: ${$('#ue').value}\nTemporary password: ${r.password}\nShare it privately. They can change it in ⚙ Settings.`;
        $('#un').value = $('#ue').value = $('#up').value = '';
      }
      else if (a === 'downloadUserTemplate') {
        location.href = '/api/admin/users/import-template';
      }
      else if (a === 'bulkImport') {
        const file = $('#user-import')?.files[0];
        if (!file) throw new Error('Choose an .xlsx workbook first');
        if (!file.name.toLowerCase().endsWith('.xlsx')) throw new Error('Upload an .xlsx workbook');
        const response = await fetch('/api/admin/users/import', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-requested-with': 'fetch' },
          body: file,
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Import failed');
        const lines = [
          `Created ${result.created.length} user(s). Temporary passwords are shown once; copy and share them securely.`,
          ...result.created.map(u => `${u.email}\t${u.password}\t${u.role}\t${u.position}`),
          ...result.rejected.map(u => `Row ${u.row} (${u.email || 'no email'}): ${u.error}`),
        ];
        $('#user-import-results').textContent = lines.join('\n');
        $('#user-import').value = '';
      }
      else if (a === 'rpw') { if (!confirm("Reset this user's password?")) return; const r = await post('/api/admin/users/' + b.dataset.id + '/reset'); prompt('New temporary password (copy it):', r.password); }
      else if (a === 'al') { if (await subscribePush()) alert('Push notifications are enabled on this device.'); }
    } catch (x) { err(x.message); }
  });
  addEventListener('keydown', e => { if (e.key === 'Enter' && ['ae', 'ap', 'an', 'ac'].includes(e.target.id)) document.querySelector('[data-act=login],[data-act=signup]')?.click(); });
})();
