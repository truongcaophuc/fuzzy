import { useEffect, useRef, useState } from "react";
import {
  Mic, Square, Upload, Play, Loader2, Wand2, FileAudio, RotateCcw,
  CheckCircle2, AlertTriangle, ListTree, Plus, Trash2, GitMerge, Server,
  ListChecks, Volume2, XCircle, Download, RefreshCw, X, Maximize2,
  Settings, LayoutGrid, AlignJustify, Calculator, Sparkles,
} from "lucide-react";

interface ASR { id: string; name: string; endpoint: string; model: string; apiKey: string; language: string }
interface Cfg {
  asrs: ASR[]; prompt: string; catalog: string; aliases: string;
  threshold: number; useUnidecode: boolean; usePhonetic: boolean; normalize: boolean;
  llmEnable: boolean; llmMode: string; llmBaseUrl: string; llmModel: string; llmApiKey: string;
  ttsBaseUrl: string; ttsModel: string; ttsVoice: string; ttsSpeed: number; ttsNumStep: number;
  atList: string;
}
const uid = () => Math.random().toString(36).slice(2, 8);

// 50 brand → phiên âm kiểu người Việt (mẫu auto-test)
const AT_SAMPLE = [
  ["Apple", "áp pồ"], ["Microsoft", "mai cờ rô sốp"], ["Google", "gu gồ"], ["Amazon", "a ma dôn"],
  ["Netflix", "nét phít"], ["Intel", "in tồ"], ["Oracle", "o ra cồ"], ["Cisco", "xít cô"],
  ["Salesforce", "xeo phọt"], ["IBM", "ai bi em"], ["Coca-Cola", "cô ca cô la"], ["Pepsi", "pép xi"],
  ["Starbucks", "sờ ta bấc"], ["McDonald's", "mắc đô nồ"], ["KFC", "ca ép xi"], ["Burger King", "bơ gơ king"],
  ["Subway", "sấp quây"], ["Domino's", "đô mi nô"], ["Heineken", "hai nơ ken"], ["Red Bull", "rét bun"],
  ["Nike", "nai ki"], ["Adidas", "a đi đát"], ["Puma", "pu ma"], ["Under Armour", "ăn đờ a mờ"],
  ["Levi's", "li vai"], ["Calvin Klein", "can vin klai"], ["Tommy Hilfiger", "tô mi hin phi gơ"],
  ["Ralph Lauren", "ráp lo ren"], ["Victoria's Secret", "víc to ri a sí cờ rịt"], ["New Balance", "niu ba lừn"],
  ["Ford", "pho"], ["Chevrolet", "sép rô lê"], ["Tesla", "tét la"], ["Boeing", "bô inh"],
  ["Caterpillar", "ca tơ pi lờ"], ["Harley-Davidson", "ha li đây vít sần"], ["Goodyear", "gút dia"],
  ["Uber", "u bờ"], ["FedEx", "phét ét"], ["DHL", "đê hát eo"], ["Shopee", "sốp pi"], ["Grab", "gờ ráp"],
  ["Johnson & Johnson", "giôn sơn en giôn sơn"], ["Walmart", "qua mát"], ["Visa", "vi sa"],
  ["Mastercard", "mát tơ cát"], ["Disney", "đít ni"], ["Milo", "mi lô"], ["Colgate", "con gết"], ["Adobe", "a đô bi"],
].map(([b, p]) => `${b} => cho tôi hỏi về ${p} nha`).join("\n");

const TTS_VOICES = [
  { id: "nu_ai", name: "Giọng nữ 1 (Nón Lá AI)" }, { id: "nu_thanhgiang", name: "Nữ Thanh Giang" },
  { id: "nu_miennam", name: "Nữ miền Nam" }, { id: "nu_hue", name: "Huế 1" }, { id: "nu_hue2", name: "Huế 2" },
  { id: "nam_bac", name: "Nam Bắc" }, { id: "nam2", name: "Nam 2" }, { id: "nam3", name: "Nam 3" }, { id: "nam_oto", name: "Nam Oto" },
  { id: "alloy", name: "Alloy" }, { id: "echo", name: "Echo" }, { id: "fable", name: "Fable" }, { id: "onyx", name: "Onyx" },
  { id: "nova", name: "Nova" }, { id: "shimmer", name: "Shimmer" }, { id: "british_man", name: "British Man" },
  { id: "british_woman", name: "British Woman" }, { id: "mergy", name: "Mergy" }, { id: "auto", name: "Auto" },
];

const DEFAULT_CFG: Cfg = {
  asrs: [
    { id: uid(), name: "v1 · gipformer", endpoint: "http://10.120.60.211:8910/v1", model: "gipformer", apiKey: "any", language: "vi" },
    { id: uid(), name: "v2 · Qwen3-ASR", endpoint: "http://10.120.80.116:8801/v1", model: "Qwen/Qwen3-ASR-1.7B", apiKey: "", language: "vi" },
  ],
  prompt: "",
  catalog: [
    "Apple", "Microsoft", "Google", "Amazon", "Netflix", "Intel", "Oracle", "Cisco", "Salesforce", "IBM",
    "Coca-Cola", "Pepsi", "Starbucks", "McDonald's", "KFC", "Burger King", "Subway", "Domino's", "Heineken", "Red Bull",
    "Nike", "Adidas", "Puma", "Under Armour", "Levi's", "Calvin Klein", "Tommy Hilfiger", "Ralph Lauren", "Victoria's Secret", "New Balance",
    "Ford", "Chevrolet", "Tesla", "Boeing", "Caterpillar", "Harley-Davidson", "Goodyear", "Uber", "FedEx", "DHL",
    "Shopee", "Grab", "Johnson & Johnson", "Walmart", "Visa", "Mastercard", "Disney", "Milo", "Colgate", "Adobe",
  ].join("\n"),
  aliases: "",
  threshold: 75, useUnidecode: true, usePhonetic: true, normalize: true,
  llmEnable: false, llmMode: "verify", llmBaseUrl: "http://10.120.80.3:5000",
  llmModel: "gemma-4-26B-A4B-it-AWQ-4bit", llmApiKey: "",
  ttsBaseUrl: "http://10.120.80.116:6655", ttsModel: "omnivoice", ttsVoice: "nu_ai", ttsSpeed: 1, ttsNumStep: 11,
  atList: AT_SAMPLE,
};
const LS_KEY = "stt-studio-multi-cfg";

interface Match { original: string; replaced: string; score: number }
interface Res { name: string; raw: string; normalized: string; matches: Match[]; latency_ms: number; error?: string; expected_score?: number }
interface Merged { text: string; agreed: boolean; method: string; primary: string | null }
interface Candidate { brand: string; span: string; score: number }
interface AtItem {
  expected: string; text: string; results: Res[]; merged: Merged | null;
  pass: boolean; matched_in: string[]; error?: string; audio_b64?: string; best_score?: number;
  candidates?: Candidate[]; llm_action?: string; merged_raw?: string; fuzzy_suggest?: string;
}
interface AtSummary { total: number; passed: number; pass_rate: number }

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

// parse "Brand => phiên âm" mỗi dòng → [{expected, text}]
function parseList(raw: string): { expected: string; text: string }[] {
  const out: { expected: string; text: string }[] = [];
  (raw || "").split("\n").forEach((line) => {
    const l = line.trim();
    if (!l || l.startsWith("#")) return;
    const sep = l.includes("=>") ? "=>" : (l.includes("=") ? "=" : null);
    if (!sep) return;
    const idx = l.indexOf(sep);
    const expected = l.slice(0, idx).trim();
    const text = l.slice(idx + sep.length).trim();
    if (expected && text) out.push({ expected, text });
  });
  return out;
}
// như parseList nhưng GIỮ item text rỗng (cho grid editor) + KHÔNG trim text
// (trim sẽ xoá dấu cách cuối ngay khi gõ → không gõ được space). Chỉ bỏ 1 space của " => ".
function parseListGrid(raw: string): { expected: string; text: string }[] {
  const out: { expected: string; text: string }[] = [];
  (raw || "").split("\n").forEach((line) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const sep = line.includes("=>") ? "=>" : (line.includes("=") ? "=" : null);
    if (!sep) { out.push({ expected: line.replace(/^\s+/, ""), text: "" }); return; }
    const idx = line.indexOf(sep);
    const expected = line.slice(0, idx).replace(/^\s+/, "").replace(/ $/, "");
    const text = line.slice(idx + sep.length).replace(/^ /, "");
    if (expected) out.push({ expected, text });
  });
  return out;
}
function joinListGrid(items: { expected: string; text: string }[]): string {
  return items.map((x) => `${x.expected} => ${x.text}`).join("\n");
}
function parseAliases(raw: string): Record<string, string> {
  const aliases: Record<string, string> = {};
  (raw || "").split("\n").forEach((line) => {
    const sep = line.includes("=>") ? "=>" : (line.includes("=") ? "=" : null);
    if (!sep) return;
    const idx = line.indexOf(sep);
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + sep.length).trim();
    if (k && v) aliases[k] = v;
  });
  return aliases;
}

function playB64(b64: string, rate = 1) {
  const a = new Audio(`data:audio/wav;base64,${b64}`);
  a.playbackRate = rate;   // server bỏ qua speed → tăng tốc khi nghe lại ở client
  a.play().catch(() => {});
}
const slug = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "audio";
function downloadB64(b64: string, filename: string) {
  const a = document.createElement("a");
  a.href = `data:audio/wav;base64,${b64}`;
  a.download = filename;
  a.click();
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

  const [mode, setMode] = useState<"transcribe" | "autotest" | "settings" | "fuzzy">("autotest");
  const [listView, setListView] = useState<"grid" | "text">("grid");
  const [ftText, setFtText] = useState("anh đi ra ngoài mua qua mát");
  const [ftResult, setFtResult] = useState<{ raw: string; fuzzy: string; matches: Match[]; candidates: Candidate[]; llm_action: string; final: string; llm_pick?: string | null; llm_note?: string | null } | null>(null);
  const [ftRunning, setFtRunning] = useState(false);
  const [ftError, setFtError] = useState("");

  const [blob, setBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [recording, setRecording] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Res[] | null>(null);
  const [merged, setMerged] = useState<Merged | null>(null);
  const [tcCandidates, setTcCandidates] = useState<Candidate[]>([]);
  const [tcAction, setTcAction] = useState<string>("");
  const [tcLlm, setTcLlm] = useState<{ pick?: string | null; note?: string | null }>({});
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // ---- auto-test state ----
  const [atRunning, setAtRunning] = useState(false);
  const [atItems, setAtItems] = useState<AtItem[] | null>(null);
  const [atSummary, setAtSummary] = useState<AtSummary | null>(null);
  const [atError, setAtError] = useState("");
  const [atRerunIdx, setAtRerunIdx] = useState<number | null>(null);
  const [editIdx, setEditIdx] = useState<number | null>(null);   // dòng đang mở popup editor
  const [editText, setEditText] = useState("");

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

  const buildPayloadCommon = () => ({
    asrs: cfg.asrs.map((a) => ({ name: a.name, endpoint: a.endpoint, model: a.model, api_key: a.apiKey, language: a.language, prompt: cfg.prompt })),
    catalog: (cfg.catalog || "").split("\n").map((s) => s.trim()).filter(Boolean),
    aliases: parseAliases(cfg.aliases),
    threshold: cfg.threshold, use_unidecode: cfg.useUnidecode, use_phonetic: cfg.usePhonetic, normalize: cfg.normalize,
    use_llm: cfg.llmEnable, llm_mode: cfg.llmMode,
    llm: { base_url: cfg.llmBaseUrl, model: cfg.llmModel, api_key: cfg.llmApiKey },
  });

  const transcribe = async () => {
    if (!blob) { setError("Chưa có audio — upload file hoặc thu mic trước."); return; }
    if (!cfg.asrs.length) { setError("Chưa cấu hình ASR nào."); return; }
    setLoading(true); setError(""); setResults(null); setMerged(null);
    try {
      const common = buildPayloadCommon();
      const fd = new FormData();
      fd.append("file", blob, blob instanceof File ? blob.name : "recording.webm");
      fd.append("asrs", JSON.stringify(common.asrs));
      fd.append("catalog", JSON.stringify(common.catalog));
      fd.append("aliases", JSON.stringify(common.aliases));
      fd.append("threshold", String(cfg.threshold));
      fd.append("use_unidecode", String(cfg.useUnidecode));
      fd.append("use_phonetic", String(cfg.usePhonetic));
      fd.append("normalize", String(cfg.normalize));
      fd.append("use_llm", String(cfg.llmEnable));
      fd.append("llm_mode", cfg.llmMode);
      fd.append("llm", JSON.stringify(common.llm));
      const r = await fetch("/api/transcribe_multi", { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Lỗi không rõ");
      setResults(data.results); setMerged(data.merged);
      setTcCandidates(data.candidates || []); setTcAction(data.llm_action || "");
      setTcLlm({ pick: data.llm_pick, note: data.llm_note });
    } catch (e) { setError(e instanceof Error ? e.message : "Transcribe thất bại"); }
    finally { setLoading(false); }
  };

  const runAutotest = async () => {
    const items = parseList(cfg.atList);
    if (!items.length) { setAtError("List rỗng — mỗi dòng dạng: Brand => phiên âm"); return; }
    if (!cfg.asrs.length) { setAtError("Chưa cấu hình ASR nào."); return; }
    setAtRunning(true); setAtError(""); setAtItems(null); setAtSummary(null);
    try {
      const common = buildPayloadCommon();
      const payload = {
        ...common,
        tts: { base_url: cfg.ttsBaseUrl, model: cfg.ttsModel, voice: cfg.ttsVoice, speed: cfg.ttsSpeed, num_step: cfg.ttsNumStep },
        items, include_audio: true, concurrency: 4,
      };
      const r = await fetch("/api/autotest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Lỗi không rõ");
      setAtItems(data.items); setAtSummary(data.summary);
    } catch (e) { setAtError(e instanceof Error ? e.message : "Auto-test thất bại"); }
    finally { setAtRunning(false); }
  };

  // sửa phiên âm inline (chỉ đổi trong bảng, chưa chạy lại)
  const setItemText = (i: number, text: string) =>
    setAtItems((items) => items ? items.map((it, j) => j === i ? { ...it, text } : it) : items);

  const recompute = (items: AtItem[]) => {
    const total = items.length, passed = items.filter((it) => it.pass).length;
    setAtSummary({ total, passed, pass_rate: total ? Math.round(1000 * passed / total) / 10 : 0 });
  };

  // đồng bộ phiên âm đã sửa vào ô list (để lần chạy full sau dùng bản mới)
  const syncAtList = (expected: string, text: string) => setCfg((c) => {
    let done = false;
    const lines = (c.atList || "").split("\n").map((line) => {
      if (done) return line;
      const sep = line.includes("=>") ? "=>" : (line.includes("=") ? "=" : null);
      if (!sep) return line;
      if (line.slice(0, line.indexOf(sep)).trim() === expected) { done = true; return `${expected} => ${text}`; }
      return line;
    });
    return { ...c, atList: lines.join("\n") };
  });

  const openEditor = (i: number) => { if (atItems) { setEditText(atItems[i].text); setEditIdx(i); } };

  // chạy lại RIÊNG 1 dòng (TTS + STT đúng item đó), cập nhật tại chỗ
  const rerunOne = async (i: number, overrideText?: string) => {
    if (!atItems) return;
    const it = atItems[i];
    const text = (overrideText !== undefined ? overrideText : it.text).trim();
    if (!text) { setAtError("Phiên âm rỗng."); return; }
    setAtRerunIdx(i); setAtError("");
    try {
      const common = buildPayloadCommon();
      const payload = {
        ...common,
        tts: { base_url: cfg.ttsBaseUrl, model: cfg.ttsModel, voice: cfg.ttsVoice, speed: cfg.ttsSpeed, num_step: cfg.ttsNumStep },
        items: [{ expected: it.expected, text }], include_audio: true, concurrency: 1,
      };
      const r = await fetch("/api/autotest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Lỗi không rõ");
      const updated = atItems.map((x, j) => j === i ? data.items[0] : x);
      setAtItems(updated); recompute(updated); syncAtList(it.expected, text);
    } catch (e) { setAtError(e instanceof Error ? e.message : "Chạy lại thất bại"); }
    finally { setAtRerunIdx(null); }
  };

  const exportCsv = () => {
    if (!atItems) return;
    const rows = [["expected", "text", "pass", "matched_in", "merged", ...cfg.asrs.map((a) => `raw:${a.name}`)]];
    atItems.forEach((it) => rows.push([
      it.expected, it.text, it.pass ? "PASS" : "FAIL", (it.matched_in || []).join("|"),
      it.merged?.text || "", ...it.results.map((r) => r.raw || r.error || ""),
    ]));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
    a.download = "autotest_results.csv"; a.click();
  };

  // ----- grid editor cho list test -----
  const listItems = parseListGrid(cfg.atList);
  const updateListItem = (i: number, field: "expected" | "text", val: string) => {
    const items = parseListGrid(cfg.atList);
    if (!items[i]) return;
    items[i] = { ...items[i], [field]: val };
    set("atList", joinListGrid(items));
  };
  const removeListItem = (i: number) => set("atList", joinListGrid(parseListGrid(cfg.atList).filter((_, j) => j !== i)));
  const addListItem = () => set("atList", joinListGrid([...parseListGrid(cfg.atList), { expected: "Brand mới", text: "" }]));

  const runFuzzyText = async () => {
    if (!ftText.trim()) { setFtError("Nhập text trước."); return; }
    setFtRunning(true); setFtError(""); setFtResult(null);
    try {
      const common = buildPayloadCommon();
      const r = await fetch("/api/fuzzy_text", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: ftText, catalog: common.catalog, aliases: common.aliases, threshold: cfg.threshold, use_unidecode: cfg.useUnidecode, use_phonetic: cfg.usePhonetic, use_llm: common.use_llm, llm_mode: common.llm_mode, llm: common.llm }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Lỗi");
      setFtResult(data);
    } catch (e) { setFtError(e instanceof Error ? e.message : "Tính fuzzy thất bại"); }
    finally { setFtRunning(false); }
  };

  const inputCls = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500";
  const itemCount = parseList(cfg.atList).length;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-5 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white"><FileAudio size={22} /></div>
        <h1 className="text-[20px] font-extrabold text-slate-800">STT Studio · Multi-ASR</h1>
        <div className="flex-1" />
        <button
          onClick={() => { if (confirm("Khôi phục toàn bộ cấu hình về mặc định?")) { localStorage.removeItem(LS_KEY); setCfg(DEFAULT_CFG); } }}
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12.5px] font-semibold text-slate-600 hover:bg-slate-50"
          title="Xoá cấu hình đã lưu, nạp lại mặc định"
        >
          <RotateCcw size={14} /> Khôi phục mặc định
        </button>
      </header>

      {/* ===== TABS ===== */}
      <div className="mb-5 flex gap-1 rounded-xl bg-slate-100 p-1">
        {([["autotest", "Auto Test (TTS→STT)", ListChecks], ["transcribe", "Transcribe", Mic], ["fuzzy", "Fuzzy (text)", Calculator], ["settings", "Cài đặt", Settings]] as const).map(([m, label, Icon]) => (
          <button key={m} onClick={() => setMode(m)}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-[13.5px] font-bold transition ${mode === m ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>

      {mode === "settings" && (
      <div className="grid gap-5 lg:grid-cols-2">
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
              <span className="mb-1 block text-[12px] font-semibold text-slate-600">Alias — cách đọc lơ lớ → tên chuẩn</span>
              <textarea value={cfg.aliases} onChange={(e) => set("aliases", e.target.value)} rows={4} placeholder="bọt tre => Porsche" className={inputCls} />
              <span className="mt-1 block text-[11px] text-slate-400">mỗi dòng: <code>cách đọc =&gt; tên chuẩn</code> — bắt brand tiếng Anh đọc lệch xa mà fuzzy không nhận</span>
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-slate-600">Ngưỡng fuzzy = ngưỡng auto-commit: {cfg.threshold} <span className="font-normal text-slate-400">(cả fuzzy thô lẫn gating dùng chung)</span></span>
              <input type="range" min={50} max={100} value={cfg.threshold} onChange={(e) => set("threshold", Number(e.target.value))} className="w-full accent-brand-600" />
            </label>
            <div className="flex gap-5">
              <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={cfg.useUnidecode} onChange={(e) => set("useUnidecode", e.target.checked)} className="h-4 w-4 accent-brand-600" /> Bỏ dấu (unidecode)</label>
              <label className="flex items-center gap-2 text-sm text-slate-600" title="Đổi cách đọc Việt của âm w/j/f về dạng Anh để fuzzy khớp (qua→wa, ph→f, gi→j)"><input type="checkbox" checked={cfg.usePhonetic} onChange={(e) => set("usePhonetic", e.target.checked)} className="h-4 w-4 accent-brand-600" /> Phonetic VN→EN</label>
              <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={cfg.normalize} onChange={(e) => set("normalize", e.target.checked)} className="h-4 w-4 accent-brand-600" /> Bật chuẩn hoá</label>
            </div>
          </section>
          {/* ===== LLM arbiter ===== */}
          <section className="space-y-3 rounded-2xl bg-white p-5 shadow-sm lg:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-[15px] font-bold text-slate-700"><Sparkles size={17} /> LLM arbiter — phân định brand theo ngữ cảnh (đồng âm)</h2>
              <label className="flex items-center gap-2 text-sm font-semibold text-slate-600"><input type="checkbox" checked={cfg.llmEnable} onChange={(e) => set("llmEnable", e.target.checked)} className="h-4 w-4 accent-brand-600" /> Bật LLM</label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[12px] font-semibold text-slate-600">Chế độ</span>
                <select value={cfg.llmMode} onChange={(e) => set("llmMode", e.target.value)} className={inputCls}>
                  <option value="smart">smart — chỉ hỏi LLM ca chưa-chắc (nhanh, ca auto chốt thẳng)</option>
                  <option value="verify">verify — LLM kiểm CẢ ca auto (bắt đồng âm điểm cao: qua mặt→Walmart)</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[12px] font-semibold text-slate-600">Model</span>
                <input value={cfg.llmModel} onChange={(e) => set("llmModel", e.target.value)} placeholder="gemma-4-26B-A4B-it-AWQ-4bit" className={inputCls} />
              </label>
              <label className="block">
                <span className="mb-1 block text-[12px] font-semibold text-slate-600">Base URL (OpenAI-compatible)</span>
                <input value={cfg.llmBaseUrl} onChange={(e) => set("llmBaseUrl", e.target.value)} placeholder="http://10.120.80.3:5000" className={inputCls} />
              </label>
              <label className="block">
                <span className="mb-1 block text-[12px] font-semibold text-slate-600">API Key</span>
                <input value={cfg.llmApiKey} onChange={(e) => set("llmApiKey", e.target.value)} type="password" placeholder="sk-..." className={inputCls} />
              </label>
            </div>
            <span className="block text-[11px] text-slate-400">Chỉ gọi LLM khi có ứng viên brand (không phải mọi câu). <b>verify</b> chậm hơn (~0.5s/lần) nhưng bắt được đồng âm điểm cao mà fuzzy chịu thua.</span>
          </section>
          {/* ===== TTS (popthink/OmniVoice) ===== */}
          <section className="space-y-3 rounded-2xl bg-white p-5 shadow-sm lg:col-span-2">
            <h2 className="flex items-center gap-2 text-[15px] font-bold text-slate-700"><Volume2 size={17} /> Cấu hình TTS (popthink / OmniVoice) — dùng cho Auto Test</h2>
            <input value={cfg.ttsBaseUrl} onChange={(e) => set("ttsBaseUrl", e.target.value)} placeholder="http://10.120.80.116:6655" className={inputCls} />
            <div className="grid gap-2 sm:grid-cols-2">
              <input value={cfg.ttsModel} onChange={(e) => set("ttsModel", e.target.value)} placeholder="omnivoice" className={inputCls} />
              <select value={cfg.ttsVoice} onChange={(e) => set("ttsVoice", e.target.value)} className={inputCls}>
                {TTS_VOICES.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="mb-1 block text-[12px] font-semibold text-slate-600">Tốc độ audio (gửi STT): {cfg.ttsSpeed}× <span className="font-normal text-slate-400">(time-stretch, giữ cao độ)</span></span>
                <input type="range" min={0.5} max={2} step={0.1} value={cfg.ttsSpeed} onChange={(e) => set("ttsSpeed", Number(e.target.value))} className="w-full accent-brand-600" /></label>
              <label className="block"><span className="mb-1 block text-[12px] font-semibold text-slate-600">Num step: {cfg.ttsNumStep}</span>
                <input type="range" min={6} max={32} value={cfg.ttsNumStep} onChange={(e) => set("ttsNumStep", Number(e.target.value))} className="w-full accent-brand-600" /></label>
            </div>
          </section>
      </div>
      )}

      {mode === "transcribe" && (
        <div className="mx-auto max-w-3xl space-y-5">
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
                  {tcAction && tcAction !== "auto" && tcCandidates.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1 text-[12px]">
                      <span className="font-semibold text-amber-600">chưa chốt — ứng viên:</span>
                      {tcCandidates.map((c, j) => <span key={j} className="rounded bg-violet-50 px-1.5 py-0.5 text-violet-700" title={`khớp cụm "${c.span}"`}>{c.brand} {c.score}</span>)}
                    </div>
                  )}
                  {(tcLlm.pick || tcLlm.note) && (
                    <div className="mt-2 flex items-center gap-1.5 text-[12px] text-fuchsia-700"><Sparkles size={13} />
                      {tcLlm.pick ? <>LLM chọn: <b>{tcLlm.pick}</b></> : <>LLM: <b>không có brand</b></>}
                    </div>
                  )}
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
      )}

      {mode === "fuzzy" && (
        <div className="mx-auto max-w-3xl space-y-5">
          <section className="space-y-3 rounded-2xl bg-white p-5 shadow-sm">
            <h2 className="flex items-center gap-2 text-[15px] font-bold text-slate-700"><Calculator size={17} /> Tính điểm Fuzzy</h2>
            <textarea value={ftText} onChange={(e) => setFtText(e.target.value)} rows={3} placeholder="Gõ/dán câu (như STT trả về) để xem fuzzy chấm brand gì…" className={inputCls} />
            <button onClick={runFuzzyText} disabled={ftRunning || !ftText.trim()} className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 py-3 text-[15px] font-bold text-white hover:bg-brand-700 disabled:opacity-50">
              {ftRunning ? <><Loader2 size={18} className="animate-spin" /> Đang tính…</> : <><Calculator size={18} /> Tính fuzzy</>}
            </button>
            {ftError && <div className="flex items-start gap-2 rounded-lg bg-rose-50 p-3 text-[13px] text-rose-600"><AlertTriangle size={16} className="mt-0.5 shrink-0" /> {ftError}</div>}
          </section>

          {ftResult && (
            <section className="space-y-3 rounded-2xl bg-white p-5 shadow-sm">
              <div><div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">Thô (input)</div>
                <div className="rounded-lg bg-slate-50 p-2.5 text-[13.5px] text-slate-700">{ftResult.raw}</div></div>
              <div><div className="mb-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-emerald-600"><CheckCircle2 size={12} /> Kết quả (sau gating @{cfg.threshold})</div>
                <div className="rounded-lg bg-emerald-50/50 p-2.5 text-[13.5px] text-slate-800">{ftResult.final === ftResult.raw ? ftResult.final : <Highlight text={ftResult.final} matches={ftResult.matches} />}</div></div>
              {ftResult.final !== ftResult.fuzzy && ftResult.fuzzy !== ftResult.raw && (
                <div className="text-[11.5px] text-amber-600">⚠ fuzzy muốn sửa thành "<b>{ftResult.fuzzy}</b>" nhưng gating giữ lại (chưa đủ tin).</div>
              )}
              {ftResult.matches.length > 0 && ftResult.final !== ftResult.raw && (
                <div className="flex flex-wrap items-center gap-1 text-[11.5px] text-slate-500"><ListTree size={13} /> khớp:
                  {ftResult.matches.map((m, j) => <span key={j} className="rounded bg-slate-100 px-1.5 py-0.5"><span className="text-rose-500 line-through">{m.original}</span>→<b className="text-emerald-700">{m.replaced}</b> {m.score}</span>)}
                </div>
              )}
              <div>
                <div className="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-violet-500">Ứng viên (đã lọc)
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${ftResult.llm_action === "auto" ? "bg-emerald-100 text-emerald-700" : ftResult.llm_action === "llm" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}`}>{ftResult.llm_action === "auto" ? "AUTO (commit)" : ftResult.llm_action === "llm" ? "→ LLM (giữ)" : "skip"}</span>
                </div>
                {ftResult.candidates.length > 0
                  ? <div className="flex flex-wrap gap-1">{ftResult.candidates.map((c, j) => <span key={j} className="rounded bg-violet-50 px-1.5 py-0.5 text-[12px] text-violet-700" title={`cụm "${c.span}"`}>{c.brand} <b>{c.score}</b></span>)}</div>
                  : <span className="text-[12px] text-slate-400">— không có ứng viên ≥ 50</span>}
              </div>
              {(ftResult.llm_pick || ftResult.llm_note) && (
                <div className="flex items-center gap-1.5 rounded-lg bg-fuchsia-50 p-2 text-[12px] text-fuchsia-700"><Sparkles size={13} className="shrink-0" />
                  {ftResult.llm_pick ? <>LLM chọn: <b>{ftResult.llm_pick}</b></> : <>LLM: <b>không có brand</b> → giữ nguyên câu</>}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {mode === "autotest" && (
        <div className="space-y-5">
          <section className="space-y-3 rounded-2xl bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-[15px] font-bold text-slate-700"><ListChecks size={17} /> List test ({itemCount} mục)</h2>
              <div className="flex flex-wrap gap-2">
                <div className="flex overflow-hidden rounded-lg border border-slate-200">
                  <button onClick={() => setListView("grid")} className={`flex items-center gap-1 px-2.5 py-1.5 text-[12px] font-semibold ${listView === "grid" ? "bg-brand-50 text-brand-700" : "text-slate-500"}`}><LayoutGrid size={13} /> Lưới</button>
                  <button onClick={() => setListView("text")} className={`flex items-center gap-1 px-2.5 py-1.5 text-[12px] font-semibold ${listView === "text" ? "bg-brand-50 text-brand-700" : "text-slate-500"}`}><AlignJustify size={13} /> Văn bản</button>
                </div>
                <label className="cursor-pointer rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12px] font-semibold text-slate-600 hover:bg-slate-50">
                  <Upload size={13} className="mr-1 inline" />Upload
                  <input type="file" accept=".txt,.csv,.md" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) f.text().then((t) => set("atList", t)); }} />
                </label>
                <button onClick={() => set("atList", AT_SAMPLE)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12px] font-semibold text-slate-600 hover:bg-slate-50">Mẫu 50 brand</button>
              </div>
            </div>
            {listView === "grid" ? (
              <>
                <div className="grid max-h-[460px] grid-cols-1 gap-2 overflow-auto pr-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {listItems.map((it, i) => (
                    <div key={i} className="rounded-lg border border-slate-200 p-2 hover:border-slate-300">
                      <div className="mb-1 flex items-center gap-1">
                        <span className="text-[10px] font-bold text-slate-300">{i + 1}</span>
                        <input value={it.expected} onChange={(e) => updateListItem(i, "expected", e.target.value)} className="min-w-0 flex-1 bg-transparent text-[12.5px] font-bold text-slate-700 outline-none" />
                        <button onClick={() => removeListItem(i)} title="Xoá" className="text-slate-300 hover:text-rose-500"><X size={12} /></button>
                      </div>
                      <input value={it.text} onChange={(e) => updateListItem(i, "text", e.target.value)} placeholder="câu chứa phiên âm…" className="w-full rounded border border-slate-200 px-1.5 py-1 text-[12px] italic outline-none focus:border-brand-500" />
                    </div>
                  ))}
                </div>
                <button onClick={addListItem} className="flex items-center gap-1 rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-[12.5px] font-semibold text-slate-500 hover:border-brand-400 hover:text-brand-600"><Plus size={14} /> Thêm mục</button>
              </>
            ) : (
              <textarea value={cfg.atList} onChange={(e) => set("atList", e.target.value)} rows={10} placeholder="Goodyear => gút dia&#10;Walmart => qua mát" className={`${inputCls} font-mono text-[12.5px]`} />
            )}
            <span className="block text-[11px] text-slate-400">mỗi mục: <code>Brand kỳ vọng → câu chứa phiên âm</code> (bọc brand trong câu ~5 từ — Qwen nhận tốt hơn từ đơn). TTS đọc → {cfg.asrs.length} ASR → tìm brand.</span>
            <button onClick={runAutotest} disabled={atRunning || !itemCount} className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 py-3 text-[15px] font-bold text-white hover:bg-brand-700 disabled:opacity-50">
              {atRunning ? <><Loader2 size={18} className="animate-spin" /> Đang test {itemCount} mục (TTS→STT)…</> : <><Play size={18} /> Chạy auto-test {itemCount} mục</>}
            </button>
            {atError && <div className="flex items-start gap-2 rounded-lg bg-rose-50 p-3 text-[13px] text-rose-600"><AlertTriangle size={16} className="mt-0.5 shrink-0" /> {atError}</div>}
          </section>

              {atSummary && (
                <section className="rounded-2xl border-2 border-brand-200 bg-brand-50/40 p-5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-[28px] font-extrabold text-brand-700">{atSummary.pass_rate}%</span>
                      <div className="text-[13px] text-slate-600">
                        <div><b className="text-emerald-600">{atSummary.passed}</b> nhận đúng / {atSummary.total} mục</div>
                        <div className="text-rose-500">{atSummary.total - atSummary.passed} sai</div>
                      </div>
                    </div>
                    <button onClick={exportCsv} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12.5px] font-semibold text-slate-600 hover:bg-slate-50"><Download size={14} /> CSV</button>
                  </div>
                </section>
              )}

              {atItems && (
                <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
                  <table className="w-full text-[12.5px]">
                    <thead><tr className="border-b bg-slate-50 text-left text-[11px] uppercase text-slate-400">
                      <th className="px-3 py-2">Brand</th><th className="px-2 py-2">Đọc (sửa + ↻)</th><th className="px-2 py-2">Kết quả ASR (thô)</th><th className="px-2 py-2 text-center">fuzzy</th><th className="px-2 py-2 text-center">✓</th>
                    </tr></thead>
                    <tbody>
                      {atItems.map((it, i) => (
                        <tr key={i} className={`border-b border-slate-100 align-top ${it.pass ? "" : "bg-rose-50/40"}`}>
                          <td className="px-3 py-2 font-semibold text-slate-700">{it.expected}</td>
                          <td className="px-2 py-2 text-slate-500">
                            <div className="flex items-center gap-1">
                              <button onClick={() => openEditor(i)} title="Bấm để mở editor lớn"
                                className="flex w-28 items-center gap-1 rounded border border-slate-200 px-1.5 py-1 text-left text-[12px] italic text-slate-600 hover:border-brand-400 hover:bg-brand-50/40">
                                <span className="flex-1 truncate">{it.text}</span><Maximize2 size={11} className="shrink-0 text-slate-400" />
                              </button>
                              {it.audio_b64 && <button onClick={() => playB64(it.audio_b64!)} title="Nghe TTS (đúng tốc độ đã gửi STT)" className="text-brand-500 hover:text-brand-700"><Volume2 size={13} /></button>}
                              {it.audio_b64 && <button onClick={() => downloadB64(it.audio_b64!, `${slug(it.expected)}__${slug(it.text)}.wav`)} title="Tải audio (.wav)" className="text-slate-400 hover:text-brand-600"><Download size={13} /></button>}
                              <button onClick={() => rerunOne(i)} disabled={atRerunIdx !== null} title="Chạy lại riêng dòng này (Enter)" className="text-slate-400 hover:text-brand-600 disabled:opacity-40">
                                {atRerunIdx === i ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                              </button>
                            </div>
                          </td>
                          <td className="px-2 py-2 text-slate-600">
                            {it.error ? <span className="text-rose-500">{it.error}</span> : (
                              <div className="space-y-0.5">
                                {it.results.map((r, j) => (
                                  <div key={j} className="flex gap-1">
                                    <span className="text-slate-400">{r.name.split("·").pop()?.trim()}:</span>
                                    <span className={it.matched_in.includes(r.name) ? "font-semibold text-emerald-700" : ""}>{r.error ? <em className="text-rose-400">lỗi</em> : (r.raw || "∅")}</span>
                                    {r.expected_score !== undefined && !r.error && <span className="text-slate-300">[{r.expected_score}]</span>}
                                  </div>
                                ))}
                                {it.merged && (it.llm_action === "auto"
                                  ? <div className="flex gap-1"><span className="text-brand-400">gộp:</span><b className={it.pass ? "text-emerald-700" : "text-slate-700"}>{it.merged.text || "∅"}</b></div>
                                  : <div className="flex flex-wrap gap-1"><span className="text-brand-400">gộp:</span><b className="text-slate-700">{it.merged.text || "∅"}</b>{it.candidates && it.candidates.length > 0 && <span className="text-amber-500">— chưa chốt, xem ứng viên ↓</span>}</div>
                                )}
                                {it.candidates && it.candidates.length > 0 && (
                                  <div className="flex flex-wrap items-center gap-1 pt-0.5">
                                    <span className="text-violet-400">ứng viên:</span>
                                    {it.candidates.map((c, j) => (
                                      <span key={j} className={`rounded px-1 ${c.brand === it.expected ? "bg-emerald-100 font-semibold text-emerald-700" : "bg-violet-50 text-violet-700"}`} title={`khớp cụm "${c.span}"`}>{c.brand} {c.score}</span>
                                    ))}
                                    {it.llm_action && <span className={`rounded px-1 text-[10px] font-bold ${it.llm_action === "auto" ? "bg-emerald-100 text-emerald-700" : it.llm_action === "llm" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}`}>{it.llm_action === "auto" ? "fuzzy chắc" : it.llm_action === "llm" ? "→ LLM" : "skip"}</span>}
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-2 text-center">
                            {it.best_score !== undefined && (
                              <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${it.pass ? "bg-emerald-100 text-emerald-700" : it.best_score >= 60 ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-600"}`}>{it.best_score}</span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-center">
                            {it.pass ? <CheckCircle2 size={16} className="inline text-emerald-500" /> : <XCircle size={16} className="inline text-rose-400" />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
        </div>
      )}

      {/* ===== POPUP EDITOR phiên âm ===== */}
      {editIdx !== null && atItems && atItems[editIdx] && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={() => setEditIdx(null)}>
          <div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[16px] font-bold text-slate-800">Sửa câu/phiên âm — <span className="text-brand-700">{atItems[editIdx].expected}</span></h3>
              <button onClick={() => setEditIdx(null)} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
            </div>
            <textarea autoFocus value={editText} onChange={(e) => setEditText(e.target.value)} rows={5}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { const i = editIdx; setItemText(i, editText); setEditIdx(null); rerunOne(i, editText); } }}
              className="w-full rounded-lg border border-slate-200 px-4 py-3 text-[16px] leading-relaxed outline-none focus:border-brand-500" />
            <p className="mt-2 text-[12px] text-slate-400">Câu này sẽ được TTS đọc → đẩy qua STT. (Ctrl/⌘+Enter = Lưu &amp; chạy lại)</p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setEditIdx(null)} className="rounded-lg border border-slate-200 px-4 py-2 text-[13.5px] font-semibold text-slate-600 hover:bg-slate-50">Đóng</button>
              <button onClick={() => { setItemText(editIdx, editText); setEditIdx(null); }} className="rounded-lg bg-slate-100 px-4 py-2 text-[13.5px] font-semibold text-slate-700 hover:bg-slate-200">Lưu</button>
              <button onClick={() => { const i = editIdx; setItemText(i, editText); setEditIdx(null); rerunOne(i, editText); }} className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-[13.5px] font-bold text-white hover:bg-brand-700"><RefreshCw size={14} /> Lưu &amp; chạy lại</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
