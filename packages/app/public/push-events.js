self.addEventListener('push', event => {
  let data; try { data = event.data.json(); } catch { return; }
  if (!data || typeof data.title !== 'string' || typeof data.body !== 'string') return;
  event.waitUntil(self.registration.showNotification(data.title, {body:data.body,tag:data.id || 'relay-digest',icon:'/icon-192.png',data:{url:'/'}}));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async windows => {
    const current = windows.find(w=>new URL(w.url).origin===self.location.origin);
    if (current) { await current.focus(); current.postMessage({type:'relay-notification'}); }
    else await self.clients.openWindow('/?notification=1');
  }));
});
