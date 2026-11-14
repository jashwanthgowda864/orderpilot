import { useEffect, useMemo, useRef, useState } from 'react';
import { api, newKey } from '../api.js';
import { useAction } from './ui.jsx';

const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
const MAX_SECONDS = 120;

// Shown while the server reads the order. Times match the server's retry policy
// (main model, one retry, then the lighter fallback model).
function loadingText(mode, s) {
  const what = mode === 'photo' ? 'Reading your photo' : mode === 'voice' ? 'Listening to your voice note' : 'Reading your order';
  if (s < 8) return `${what}…`;
  if (s < 20) return 'Matching items to the shop’s list…';
  if (s < 45) return 'The AI is slower than usual. Still working…';
  return 'Almost there. Trying a faster backup…';
}

/** Text / photo / voice order entry. customerId is set in counter mode. */
export default function OrderInput({ customerId, onCreated }) {
  const [mode, setMode] = useState('text');
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState(null);
  const [audio, setAudio] = useState(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [waited, setWaited] = useState(0);
  const recRef = useRef(null);
  const keyRef = useRef(newKey()); // same key when retrying the same input
  const { busy, error, run, setError } = useAction();

  // Object URLs for previews, created once per file and released afterwards.
  const photoUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);
  const audioUrl = useMemo(() => (audio ? URL.createObjectURL(audio) : null), [audio]);
  useEffect(() => () => photoUrl && URL.revokeObjectURL(photoUrl), [photoUrl]);
  useEffect(() => () => audioUrl && URL.revokeObjectURL(audioUrl), [audioUrl]);

  useEffect(() => () => recRef.current?.stream?.getTracks().forEach((t) => t.stop()), []);
  useEffect(() => { keyRef.current = newKey(); }, [text, photo, audio, customerId, mode]);

  // Elapsed-time counter for the loading message.
  useEffect(() => {
    if (!busy) { setWaited(0); return undefined; }
    const started = Date.now();
    const t = setInterval(() => setWaited(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [busy]);

  async function startRecording() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError(new Error('Voice recording is not supported in this browser. Please type your order.'));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = AUDIO_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = (rec.mimeType || 'audio/webm').split(';')[0];
        setAudio(new Blob(chunks, { type }));
        setRecording(false);
      };
      rec.stream = stream;
      recRef.current = rec;
      rec.start();
      setAudio(null); setSeconds(0); setRecording(true);
      const started = Date.now();
      const timer = setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        setSeconds(s);
        if (s >= MAX_SECONDS || rec.state !== 'recording') { clearInterval(timer); if (rec.state === 'recording') rec.stop(); }
      }, 250);
    } catch {
      setError(new Error('Microphone permission was denied. Please allow it or type your order.'));
    }
  }

  const stopRecording = () => recRef.current?.state === 'recording' && recRef.current.stop();

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData();
    if (mode === 'text') { if (!text.trim()) return setError(new Error('Type at least one item.')); fd.set('text', text.trim()); }
    if (mode === 'photo') { if (!photo) return setError(new Error('Choose a photo first.')); fd.set('file', photo, photo.name || 'order.jpg'); if (text.trim()) fd.set('text', text.trim()); }
    if (mode === 'voice') { if (!audio) return setError(new Error('Record a voice note first.')); fd.set('file', audio, `voice.${audio.type.split('/')[1] || 'webm'}`); }
    if (customerId) fd.set('customer_id', customerId);
    fd.set('idempotency_key', keyRef.current);
    const r = await run(() => api('POST', '/orders/parse', fd));
    // Input is cleared only on success; on any failure the text/photo/voice note stays for a retry.
    if (r?.order) { setText(''); setPhoto(null); setAudio(null); keyRef.current = newKey(); onCreated(r.order); }
  }

  const aiBusy = error?.code === 'ai_busy';
  return (
    <form className="card" onSubmit={submit} aria-busy={busy}>
      <div className="tabs" role="tablist">
        {[['text', 'Type'], ['photo', 'Photo of list'], ['voice', 'Voice note']].map(([m, label]) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'active' : ''}
            disabled={busy} onClick={() => { setMode(m); setError(null); }}>{label}</button>
        ))}
      </div>
      <fieldset disabled={busy} className="plain">
        {mode === 'text' && (
          <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} aria-label="Your order"
            placeholder={'One item per line, any language. e.g.\n2 kg sugar\n1 toor dal\nಎಣ್ಣೆ 1 ಲೀಟರ್'} />
        )}
        {mode === 'photo' && (
          <div className="stack">
            <input type="file" accept="image/jpeg,image/png,image/webp,image/heic" capture="environment" aria-label="Photo of your list"
              onChange={(e) => setPhoto(e.target.files?.[0] || null)} />
            {photoUrl && <img className="preview" src={photoUrl} alt="Selected order list" />}
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Optional note (e.g. 'and 2 milk')" maxLength={1000} />
          </div>
        )}
        {mode === 'voice' && (
          <div className="stack">
            {!recording ? (
              <button type="button" className="secondary" onClick={startRecording}>{audio ? 'Record again' : 'Start recording'}</button>
            ) : (
              <button type="button" className="danger" onClick={stopRecording}>Stop ({seconds}s / {MAX_SECONDS}s)</button>
            )}
            {audioUrl && !recording && <audio controls src={audioUrl} />}
            <p className="muted small">Speak your items in English, Kannada or Hindi.</p>
          </div>
        )}
      </fieldset>

      {busy && (
        <div className="loading" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>{loadingText(mode, waited)}</span>
          <span className="muted small">{waited}s</span>
        </div>
      )}
      {!busy && error && (
        <div className={aiBusy ? 'banner' : 'error'} role="alert">
          <strong>{error.message}</strong>
          {(aiBusy || error.status === 0 || error.status >= 500) && (
            <div className="small">Your {mode === 'text' ? 'order text' : mode === 'photo' ? 'photo' : 'voice note'} is still here. Press “Try again”.</div>
          )}
        </div>
      )}
      <button type="submit" disabled={busy || recording}>
        {busy ? 'Working…' : error && (aiBusy || error.status === 0 || error.status >= 500) ? 'Try again' : 'Continue'}
      </button>
    </form>
  );
}
