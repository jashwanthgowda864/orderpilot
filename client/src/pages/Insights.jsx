import { useEffect, useMemo, useRef, useState } from 'react';
import { api, post } from '../api.js';
import { useAction } from '../components/ui.jsx';

const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
const EXAMPLES = [
  'Sales this month',
  'Top products last 30 days',
  'Who owes the most?',
  'Ramesh balance',
  'Low stock items',
  'Orders by status',
];

function loadingText(s) {
  if (s < 6) return 'Understanding your question…';
  if (s < 12) return 'Checking store records…';
  if (s < 24) return 'The AI is slower than usual. Still working…';
  return 'Almost there. Trying a faster backup…';
}

export default function Insights() {
  const [question, setQuestion] = useState('');
  const [audio, setAudio] = useState(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [waited, setWaited] = useState(0);
  const [result, setResult] = useState(null);
  const recRef = useRef(null);
  const act = useAction();

  const audioUrl = useMemo(() => (audio ? URL.createObjectURL(audio) : null), [audio]);
  useEffect(() => () => audioUrl && URL.revokeObjectURL(audioUrl), [audioUrl]);
  useEffect(() => () => recRef.current?.stream?.getTracks().forEach((t) => t.stop()), []);

  useEffect(() => {
    if (!act.busy) { setWaited(0); return undefined; }
    const started = Date.now();
    const t = setInterval(() => setWaited(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [act.busy]);

  async function startRecording() {
    act.setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      act.setError(new Error('Voice recording is not supported in this browser. Please type your question.'));
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
      setAudio(null);
      setSeconds(0);
      setRecording(true);
      const started = Date.now();
      const timer = setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        setSeconds(s);
        if (s >= 60 || rec.state !== 'recording') {
          clearInterval(timer);
          if (rec.state === 'recording') rec.stop();
        }
      }, 250);
    } catch {
      act.setError(new Error('Microphone permission was denied. Please type your question.'));
    }
  }

  const stopRecording = () => recRef.current?.state === 'recording' && recRef.current.stop();

  const submitText = (q) => act.run(async () => {
    const res = await post('/insights/ask', { question: q.trim() });
    if (res) setResult(res);
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (act.busy) return;
    if (audio) {
      act.run(async () => {
        const fd = new FormData();
        fd.set('file', audio, `ask.${audio.type.split('/')[1] || 'webm'}`);
        if (question.trim()) fd.set('question', question.trim());
        const res = await api('POST', '/insights/ask', fd);
        if (res) { setAudio(null); setResult(res); }
      });
      return;
    }
    if (!question.trim()) return act.setError(new Error('Type a question or record a voice note.'));
    submitText(question);
  };

  const aiBusy = act.error?.code === 'ai_busy';
  return (
    <div className="stack">
      <h2>Ask your business</h2>
      <form className="card" onSubmit={handleSubmit} aria-busy={act.busy}>
        <div className="chips">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="chip" disabled={act.busy || recording}
              onClick={() => { setAudio(null); setQuestion(ex); submitText(ex); }}>
              {ex}
            </button>
          ))}
        </div>
        <div className="row wrap">
          <input
            className="grow"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask in English, Kannada or Hindi (e.g. 'Sales this week', 'Who owes the most?')"
            maxLength={500}
            disabled={act.busy}
          />
          {!recording ? (
            <button type="button" className="secondary" disabled={act.busy} onClick={startRecording}>
              {audio ? 'Record again' : 'Voice'}
            </button>
          ) : (
            <button type="button" className="danger" onClick={stopRecording}>Stop ({seconds}s)</button>
          )}
          <button type="submit" disabled={act.busy || recording}>
            {act.busy ? 'Working…' : aiBusy ? 'Try again' : 'Ask'}
          </button>
        </div>
        {audioUrl && !recording && (
          <div className="row">
            <audio controls src={audioUrl} />
            <button type="button" className="link small" onClick={() => setAudio(null)}>Clear voice</button>
          </div>
        )}
        {act.busy && (
          <div className="loading" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>{loadingText(waited)}</span>
            <span className="muted small">{waited}s</span>
          </div>
        )}
        {!act.busy && act.error && (
          <div className={aiBusy ? 'banner' : 'error'} role="alert">
            <strong>{act.error.message}</strong>
          </div>
        )}
      </form>

      {result && (
        <section className="card">
          {result.transcript && <p className="small muted">Heard: “{result.transcript}”</p>}
          <p><strong>{result.answer}</strong></p>
          {result.rows?.length > 0 && (
            <table className="list">
              <thead>
                <tr>{result.columns.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i}>{row.map((cell, j) => <td key={j}>{typeof cell === 'number' ? cell.toLocaleString('en-IN', { maximumFractionDigits: 3 }) : String(cell)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
