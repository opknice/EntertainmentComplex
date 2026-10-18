import { formatMediaTime } from './player-controls';
import PlayerIcon from './PlayerIcon';

export default function ResumePrompt({ progress, loadError, onClose }) {
  return <div className="resume-backdrop">
    <section className="resume-dialog" role="dialog" aria-modal="true" aria-labelledby="resume-title" aria-describedby="resume-description" aria-busy={progress.waiting && !loadError} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); event.stopPropagation(); buttons.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); event.stopPropagation(); buttons[0]?.focus(); }
    }}>
      {onClose && <button className="smart-icon resume-close" type="button" onClick={onClose} aria-label="ปิดเครื่องเล่น"><PlayerIcon name="close" /></button>}
      <span className="eyebrow">CONTINUE WATCHING</span>
      <h2 id="resume-title">ต้องการรับชมต่อไหม?</h2>
      <p id="resume-description">คุณดูค้างไว้ที่ <strong>{formatMediaTime(progress.saved.position)}</strong></p>
      {progress.waiting && !loadError && <p role="status">กำลังเตรียมวิดีโอและตำแหน่งรับชม…</p>}
      {loadError && <p className="resume-error" role="alert">{loadError}</p>}
      {progress.error && <p className="resume-error" role="alert">{progress.error}</p>}
      <div className="resume-actions">
        <button className="primary-button" type="button" autoFocus disabled={progress.waiting || Boolean(loadError)} onClick={() => progress.choose('continue')}>▶ เล่นต่อจาก {formatMediaTime(progress.saved.position)}</button>
        <button className="secondary-button" type="button" disabled={Boolean(loadError)} onClick={() => progress.choose('restart')}>เริ่มใหม่ตั้งแต่ต้น</button>
      </div>
      <small>จำตำแหน่งเฉพาะเบราว์เซอร์นี้บนเครื่องนี้</small>
    </section>
  </div>;
}
