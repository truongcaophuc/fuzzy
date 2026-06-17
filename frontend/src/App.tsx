import { useEffect, useRef, useState } from "react";
import {
  Settings, Mic, Square, Upload, Play, Loader2, Wand2, FileAudio,
  CheckCircle2, AlertTriangle, ListTree, Plus, Trash2, GitMerge, Server,
} from "lucide-react";

interface ASR { id: string; name: string; endpoint: string; model: string; apiKey: string; language: string }
interface Cfg {
  asrs: ASR[]; prompt: string; catalog: string;
  threshold: number; useUnidecode: boolean; normalize: boolean;
}
const uid = () => Math.random().toString(36).slice(2, 8);
const DEFAULT_CFG: Cfg = {
  asrs: [
    { id: uid(), name: "v1 · gipformer", endpoint: "http://10.120.60.211:8910/v1", model: "gipformer", apiKey: "any", language: "vi" },
    { id: uid(), name: "v2 · Qwen3-ASR", endpoint: "http://10.120.80.116:8801/v1", model: "Qwen/Qwen3-ASR-1.7B", apiKey: "", language: "vi" },
  ],
  prompt: "",
  catalog: "Galaxy S24\nGalaxy S24 Ultra\niPhone 15\nSamsung\nMacBook Air\nAirPods Pro",
  threshold: 80, useUnidecode: true, normalize: true,
};
const LS_KEY = "stt-studio-multi-cfg";

interface Match { original: string; replaced: string; score: number }
interface Res { name: string; raw: string; normalized: string; matches: Match[]; latency_ms: number; error?: string }
interface Merged { text: string; agreed: boolean; method: string; primary: string | null }

function esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function Highlight({ text, matches }: { text: string; matches: Match[] }) {
  if (!matches.length || !text) return <>{text || <em className="text-slate-400">(rỗng)</em>}</>;
  const terms = [...new Set(matches.map((m) => m.replaced))].filter(Boolean);
  if (!terms.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${terms.map(esc).join("|")})`, "g"));
  return <>{parts.map((p, i) => terms.includes(p)
    ? <mark key={i} className="rounded bg-emerald-200 px-1 font-semibold text-emerald-900">{p}</mark>
    : <span key={i}>{p}</span>)}</>;
}

export default function App() {
  const [cfg, setCfg] = useState<Cfg>(() => {
    try { return { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem(LS_KEY) || "{}") }; }
    catch { return DEFAULT_CFG; }
  });
  useEffect(() => { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); }, [cfg]);
  const set = <K extends keyof Cfg>(k: K, v: Cfg[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const setAsr = (id: string, patch: Partial<ASR>) =>
    setCfg((c) => ({ ...c, asrs: c.asrs.map((a) => a.id === id ? { ...a, ...patch } : a) }));
  const addAsr = () => setCfg((c) => ({ ...c, asrs: [...c.asrs, { id: uid(), name: `ASR ${c.asrs.length + 1}`, endpoint: "", model: "", apiKey: "", language: "vi" }] }));
  const delAsr = (id: string) => setCfg((c) => ({ ...c, asrs: c.asrs.filter((a) => a.id !== id) }));

  const [blob, setBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [recording, setRecording] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Res[] | null>(null);
  const [merged, setMerged] = useState<Merged | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const pickFile = (f: File | null) => { if (!f) return; setBlob(f); setAudioUrl(URL.createObjectURL(f)); setResults(null); setError(""); };

  const toggleRecord = async () => {
    if (recording) { recRef.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream); chunksRef.current = [];
      mr.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      mr.onstop = () => {
        const b = new Blob(chunksRef.current, { type: "audio/webm" });
        setBlob(b); setAudioUrl(URL.createObjectURL(b)); setResults(null);
        stream.getTracks().forEach((t) => t.stop()); setRecording(false);
      };
      mr.start(); recRef.current = mr; setRecording(true); setError("");
    } catch { setError("Không truy cập được mic (cấp quyền micro)."); }
  };

  const transcribe = async () => {
    if (!blob) { setError("Chưa có audio — upload file hoặc thu mic trước."); return; }
    if (!cfg.asrs.length) { setError("Chưa cấu hình ASR nào."); return; }
    setLoading(true); setError(""); setResults(null); setMerged(null);
    try {
      const asrs = cfg.asrs.map((a) => ({
        name: a.name, endpoint: a.endpoint, model: a.model,
        api_key: a.apiKey, language: a.language, prompt: cfg.prompt,
      }));
      const catalog = JSON.stringify(cfg.catalog.split("\n").map((s) => s.trim()).filter(Boolean));
      const fd = new FormData();
      fd.append("file", blob, blob instanceof File ? blob.name : "recording.webm");
      fd.append("asrs", JSON.stringify(asrs));
      fd.append("catalog", catalog);
      fd.append("threshold", String(cfg.threshold));
      fd.append("use_unidecode", String(cfg.useUnidecode));
      fd.append("normalize", String(cfg.normalize));
      const r = await fetch("/api/transcribe_multi", { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Lỗi không rõ");
      setResults(data.results); setMerged(data.merged);
    } catch (e) { setError(e instanceof Error ? e.message : "Transcribe thất bại"); }
    finally { setLoading(false); }
  };

  const inputCls = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500";

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white"><FileAudio size={22} /></div>
        <div>
          <h1 className="text-[20px] font-extrabold text-slate-800">STT Studio · Multi-ASR</h1>
          <p className="text-[12.5px] text-slate-500">Chạy song song nhiều STT + fuzzy chuẩn hoá từng bản (rapidfuzz + unidecode) + gộp</p>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* ===== CỘT TRÁI: CẤU HÌNH ===== */}
        <div className="space-y-5">
          <section className="space-y-3 rounded-2xl bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-[15px] font-bold text-slate-700"><Server size={17} /> Các model ASR ({cfg.asrs.length})</h2>
              <button onClick={addAsr} className="flex items-center gap-1 rounded-lg bg-brand-50 px-2.5 py-1.5 text-[12.5px] font-semibold text-brand-700 hover:bg-brand-100"><Plus size={14} /> Thêm ASR</button>
            </div>
            {cfg.asrs.map((a, i) => (
              <div key={a.id} className="space-y-2 rounded-xl border border-slate-200 p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-slate-400">#{i + 1}</span>
                  <input value={a.name} onChange={(e) => setAsr(a.id, { name: e.target.value })} className="flex-1 rounded-md border border-slate-200 px-2 py-1 text-[13px] font-semibold outline-none focus:border-brand-500" />
                  <button onClick={() => delAsr(a.id)} className="text-slate-300 hover:text-rose-500"><Trash2 size={16} /></button>
                </div>
                <input value={a.endpoint} onChange={(e) => setAsr(a.id, { endpoint: e.target.value })} placeholder="http://host:port/v1" className={inputCls} />
                <div className="grid grid-cols-2 gap-2">
                  <input value={a.model} onChange={(e) => setAsr(a.id, { model: e.target.value })} placeholder="model" className={inputCls} />
                  <select value={a.language} onChange={(e) => setAsr(a.id, { language: e.target.value })} className={inputCls}>
                    <option value="">Auto</option><option value="vi">vi</option><option value="en">en</option>
                  </select>
                </div>
                <input type="password" value={a.apiKey} onChange={(e) => setAsr(a.id, { apiKey: e.target.value })} placeholder="API key (tùy chọn)" className={inputCls} />
              </div>
            ))}
          </section>

          <section className="space-y-3 rounded-2xl bg-white p-5 shadow-sm">
            <h2 className="flex items-center gap-2 text-[15px] font-bold text-slate-700"><Wand2 size={16} /> Hậu xử lý fuzzy (áp cho TỪNG bản)</h2>
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-slate-600">Prompt / Hotwords (biasing — dùng chung)</span>
              <textarea value={cfg.prompt} onChange={(e) => set("prompt", e.target.value)} rows={2} placeholder="Samsung, Galaxy S24, iPhone..." className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-slate-600">Catalog brand/SKU (mỗi dòng 1 mục)</span>
              <textarea value={cfg.catalog} onChange={(e) => set("catalog", e.target.value)} rows={5} className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-slate-600">Ngưỡng fuzzy: {cfg.threshold}</span>
              <input type="range" min={50} max={100} value={cfg.threshold} onChange={(e) => set("threshold", Number(e.target.value))} className="w-full accent-brand-600" />
            </label>
            <div className="flex gap-5">
              <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={cfg.useUnidecode} onChange={(e) => set("useUnidecode", e.target.checked)} className="h-4 w-4 accent-brand-600" /> Bỏ dấu (unidecode)</label>
              <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={cfg.normalize} onChange={(e) => set("normalize", e.target.checked)} className="h-4 w-4 accent-brand-600" /> Bật chuẩn hoá</label>
            </div>
          </section>
        </div>

        {/* ===== CỘT PHẢI: AUDIO + KẾT QUẢ ===== */}
        <div className="space-y-5">
          <section className="space-y-3 rounded-2xl bg-white p-5 shadow-sm">
            <h2 className="flex items-center gap-2 text-[15px] font-bold text-slate-700"><Mic size={17} /> Audio</h2>
            <div className="flex gap-3">
              <label className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-200 py-3 text-sm font-medium text-slate-600 hover:border-brand-400">
                <Upload size={16} /> Upload file<input type="file" accept="audio/*" className="hidden" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
              </label>
              <button onClick={toggleRecord} className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-3 text-sm font-semibold text-white ${recording ? "bg-rose-500" : "bg-brand-600 hover:bg-brand-700"}`}>
                {recording ? <><Square size={15} /> Dừng thu</> : <><Mic size={16} /> Thu mic</>}
              </button>
            </div>
            {audioUrl && <div className="flex items-center gap-2 rounded-lg bg-slate-50 p-2"><Play size={15} className="text-slate-400" /><audio src={audioUrl} controls className="h-8 w-full" /></div>}
            <button onClick={transcribe} disabled={loading || !blob} className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 py-3 text-[15px] font-bold text-white hover:bg-brand-700 disabled:opacity-50">
              {loading ? <><Loader2 size={18} className="animate-spin" /> Đang chạy {cfg.asrs.length} ASR…</> : <><Wand2 size={18} /> Transcribe {cfg.asrs.length} ASR + Chuẩn hoá</>}
            </button>
            {error && <div className="flex items-start gap-2 rounded-lg bg-rose-50 p-3 text-[13px] text-rose-600"><AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}</div>}
          </section>

          {merged && (
            <section className="rounded-2xl border-2 border-brand-200 bg-brand-50/40 p-5">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px] font-bold text-brand-700">
                <GitMerge size={16} /> Kết quả gộp
                <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[11px] text-brand-700">{merged.method}</span>
                {merged.agreed
                  ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-700">các model ĐỒNG NHẤT</span>
                  : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-700">KHÁC NHAU → bỏ phiếu</span>}
              </div>
              <div className="rounded-lg bg-white p-3 text-[14px] leading-relaxed text-slate-800">{merged.text || <em className="text-slate-400">(rỗng)</em>}</div>
              {merged.primary && <div className="mt-1 text-[11.5px] text-slate-500">Hệ trọng số cao nhất (phá hoà phiếu): {merged.primary}</div>}
            </section>
          )}

          {results && results.map((res, i) => (
            <section key={i} className="space-y-3 rounded-2xl bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-bold text-slate-800">{res.name}</span>
                {res.error
                  ? <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] text-rose-600">lỗi</span>
                  : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">⏱ {res.latency_ms} ms</span>}
              </div>
              {res.error ? (
                <div className="rounded-lg bg-rose-50 p-3 text-[12.5px] text-rose-600">{res.error}</div>
              ) : (
                <>
                  <div><div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">Thô</div>
                    <div className="rounded-lg bg-slate-50 p-2.5 text-[13.5px] text-slate-700">{res.raw || <em className="text-slate-400">(rỗng)</em>}</div></div>
                  <div><div className="mb-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-emerald-600"><CheckCircle2 size={12} /> Sau chuẩn hoá</div>
                    <div className="rounded-lg bg-emerald-50/50 p-2.5 text-[13.5px] text-slate-800"><Highlight text={res.normalized} matches={res.matches} /></div></div>
                  {res.matches.length > 0 && (
                    <div className="flex items-center gap-1 text-[11.5px] text-slate-500"><ListTree size={13} />
                      {res.matches.map((m, j) => <span key={j} className="rounded bg-slate-100 px-1.5 py-0.5"><span className="text-rose-500 line-through">{m.original}</span>→<b className="text-emerald-700">{m.replaced}</b> {m.score}</span>)}
                    </div>
                  )}
                </>
              )}
            </section>
          ))}
        </div>
      </div>

      <footer className="mt-6 flex items-center justify-center gap-1.5 text-[11.5px] text-slate-400"><Settings size={12} /> backend FastAPI :8077 · fuzzy = rapidfuzz + unidecode · multi-ASR song song</footer>
    </div>
  );
}
