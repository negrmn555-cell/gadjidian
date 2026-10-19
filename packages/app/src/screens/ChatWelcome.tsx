import type { CSSProperties } from 'react';

export function ChatWelcome({ phase }: { phase: 'ready' | 'leaving' }) {
  return <div className={'chat-welcome welcome-' + phase} data-phase={phase}>
    <div className="welcome-atmosphere" aria-hidden="true"><div className="welcome-halo"><i className="aurora-orb orb-violet" /><i className="aurora-orb orb-blue" /><i className="aurora-orb orb-rose" /><i className="aurora-orb orb-amber" /></div><div className="welcome-ring" /></div>
    <h1 className="welcome-wordmark" aria-label="Gadjidian">{Array.from('Gadjidian').map((letter, index) => <span key={index} aria-hidden="true" style={{ '--letter': index } as CSSProperties}>{letter}</span>)}</h1>
  </div>;
}
