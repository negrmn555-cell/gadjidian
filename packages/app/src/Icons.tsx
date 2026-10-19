type IconName = 'menu' | 'settings' | 'plus' | 'send' | 'chat' | 'tasks' | 'close' | 'back' | 'chevron' | 'commands' | 'note' | 'file' | 'bell' | 'filter';
const paths: Record<IconName, React.ReactNode> = {
  menu: <><path d="M3 7h18M3 12h18" /></>,
  settings: <><path d="m9 3 .7 2.1a7 7 0 0 1 4.6 0L15 3l3 1.7-.7 2.2a7 7 0 0 1 2.3 4L22 11v3l-2.4.1a7 7 0 0 1-2.3 4l.7 2.2-3 1.7-.7-2.1a7 7 0 0 1-4.6 0L9 22l-3-1.7.7-2.2a7 7 0 0 1-2.3-4L2 14v-3l2.4-.1a7 7 0 0 1 2.3-4L6 4.7Z" /><circle cx="12" cy="12.5" r="3.5" /></>,
  plus: <path d="M12 3v18M3 12h18" />,
  send: <path d="M12 21V3m-8 8 8-8 8 8" />,
  chat: <path d="M20 11a8 8 0 0 1-8 8H4l-2 3V11a9 9 0 0 1 18 0Z" />,
  tasks: <><path d="m4 6 2 2 4-4m-6 9 2 2 4-4m-6 9 2 2 4-4M13 6h8m-8 7h8m-8 7h8" /></>,
  close: <path d="m5 5 14 14M19 5 5 19" />,
  back: <path d="M20 12H4m7-7-7 7 7 7" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  commands: <><path d="m7 8-4 4 4 4m10-8 4 4-4 4m-4-11-2 14" /></>,
  note: <><rect x="5" y="3" width="14" height="18" rx="3" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  file: <><path d="M14 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7l-5-5Zm0 0v4a2 2 0 0 0 2 2h3M9 13h7M9 17h7" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" /></>,
  filter: <path d="M4 5h16M7 12h10M10 19h4" />
};
export function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
