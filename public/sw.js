self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || 'FollowUp', { body: d.body || '', icon: '/icon.svg', data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
    const url = new URL(e.notification.data.url || '/', self.location.origin);
    for (const client of windows) {
      if (new URL(client.url).origin !== url.origin) continue;
      if (client.url !== url.href && client.navigate) await client.navigate(url.href);
      return client.focus();
    }
    return clients.openWindow(url.href);
  }));
});
