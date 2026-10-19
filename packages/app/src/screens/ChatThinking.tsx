interface Props { status?: string; streaming?: boolean }

/** Lives only as long as the pending assistant message; no artificial wait. */
export function ChatThinking({ status, streaming = false }: Props) {
  return <div className={'chat-thinking' + (streaming ? ' is-streaming' : '')} role="status" aria-live="polite" aria-atomic="true">
    <span className="thinking-orb" aria-hidden="true"><i /><i /><i /><span /></span>
    <span className="thinking-label">{status && status !== '…' ? status : streaming ? 'Формирую ответ…' : 'Обдумываю…'}</span>
    <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
  </div>;
}
