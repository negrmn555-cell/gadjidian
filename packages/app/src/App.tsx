import { useEffect, useState } from 'react';
import { api, getToken, isStandalone, setToken } from './api';
import { Connect } from './screens/Connect';
import { Chat } from './screens/Chat';
import { Settings } from './screens/Settings';
import { InstallGate } from './screens/InstallGate';

type Screen = 'chat' | 'settings';

export function App() {
  const [token, setTok] = useState<string | null>(getToken());
  const [screen, setScreen] = useState<Screen>('chat');
  const [requireStandalone, setRequireStandalone] = useState<boolean | null>(null);
  const [shared, setShared] = useState<string>('');

  // Text shared via Android share-target lands in /share?text=...
  useEffect(() => {
    const u = new URL(location.href);
    if (u.pathname === '/share') {
      const parts = [u.searchParams.get('title'), u.searchParams.get('text'), u.searchParams.get('url')].filter(Boolean);
      setShared(parts.join('\n'));
      history.replaceState(null, '', '/');
    }
  }, []);

  useEffect(() => {
    // Ask the server whether standalone mode is enforced (dev servers usually disable it)
    api
      .health()
      .then(() => (token ? api.me() : null))
      .then((me) => setRequireStandalone(me ? me.requireStandalone : true))
      .catch(() => setRequireStandalone(true));
  }, [token]);

  const dev = import.meta.env.DEV;
  if (!dev && requireStandalone !== false && !isStandalone()) {
    return <InstallGate />;
  }

  if (!token) {
    return (
      <Connect
        onConnected={(t) => {
          setToken(t);
          setTok(t);
        }}
      />
    );
  }

  if (screen === 'settings') {
    return (
      <Settings
        onBack={() => setScreen('chat')}
        onLogout={() => {
          setToken(null);
          setTok(null);
        }}
      />
    );
  }

  return <Chat onSettings={() => setScreen('settings')} initialText={shared} onUnauthorized={() => { setToken(null); setTok(null); }} />;
}
