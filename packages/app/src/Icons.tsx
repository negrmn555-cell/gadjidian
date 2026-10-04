type IconName = 'menu' | 'settings' | 'plus' | 'send' | 'chat' | 'tasks' | 'close' | 'back' | 'chevron' | 'commands' | 'note' | 'file';
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
  note: <><path d="M5 3h14v18H5ZM8 8h8M8 12h8M8 16h5" /></>,
  file: <><path d="M6 2h8l5 5v15H6ZM14 2v6h5M9 13h7M9 17h7" /></>,
};
export function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
