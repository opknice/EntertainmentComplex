const paths = {
  play: <path d="m9 5 11 7-11 7Z" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  volume: <><path d="m11 5-6 4H2v6h3l6 4ZM15 8c3 2 3 6 0 8M18 5c5 4 5 10 0 14" /></>,
  muted: <><path d="m11 5-6 4H2v6h3l6 4ZM16 9l6 6M22 9l-6 6" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  unlock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 7-2M12 14v3" /></>,
  settings: <><path d="m9 3-.5 3-2 1.2-2.8-1-2 3.5L4 12l-2.3 2.3 2 3.5 2.8-1 2 1.2L9 21h6l.5-3 2-1.2 2.8 1 2-3.5L20 12l2.3-2.3-2-3.5-2.8 1-2-1.2L15 3Z" /><circle cx="12" cy="12" r="3" /></>,
  fullscreen: <path d="M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
};

export default function PlayerIcon({ name }) {
  return <svg className="player-icon" width="22" height="22" viewBox="0 0 24 24" fill={name === 'play' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
