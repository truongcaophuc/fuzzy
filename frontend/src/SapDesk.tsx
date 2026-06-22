import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  PhoneIncoming, PhoneCall, Hash, Clock, Tag, Activity,
  FileText, MessagesSquare, X, Inbox, Crown,
  ListChecks, Flag, CheckCircle2, KeyRound, ChevronRight,
} from "lucide-react";

// ── Poptech · Mô phỏng màn hình SAP của điện thoại viên ────────────────────
// Nhận warm-handoff từ Dograh qua SSE (/api/handoff/stream) và "screen-pop" ngữ
// cảnh cuộc gọi (tóm tắt AI + transcript + dữ liệu khách) TRƯỚC khi ĐTV nhấc máy.

interface HandoffEvent {
  id: string;
  received_at: number;
  payload: Record<string, unknown>;
}

const SUMMARY_HEADERS = ["REASON", "AGENT ACTIONS", "RESOLUTION", "KEY INFORMATION"];
const SECTION_META: Record<string, { label: string; icon: ReactNode; accent: string }> = {
  REASON: { label: "Lý do gọi", icon: <Flag className="h-4 w-4" />, accent: "border-blue-500 text-blue-700" },
  "AGENT ACTIONS": { label: "AI đã làm", icon: <ListChecks className="h-4 w-4" />, accent: "border-indigo-500 text-indigo-700" },
  RESOLUTION: { label: "Hướng xử lý", icon: <CheckCircle2 className="h-4 w-4" />, accent: "border-emerald-500 text-emerald-700" },
  "KEY INFORMATION": { label: "Thông tin then chốt", icon: <KeyRound className="h-4 w-4" />, accent: "border-amber-500 text-amber-700" },
};

/** Lấy field đầu tiên tồn tại trong payload (hỗ trợ nhiều tên khoá). */
function pick(payload: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = payload?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return "";
}

/** Tách tóm tắt theo header REASON / AGENT ACTIONS / RESOLUTION / KEY INFORMATION. */
function parseSummary(text: string): { header: string; lines: string[] }[] {
  if (!text) return [];
  const re = new RegExp(`^\\s*(${SUMMARY_HEADERS.join("|")})\\s*:?\\s*$`, "i");
  const rawLines = text.split(/\r?\n/);
  const sections: { header: string; lines: string[] }[] = [];
  let cur: { header: string; lines: string[] } | null = null;
  for (const line of rawLines) {
    const m = line.match(re);
    if (m) {
      cur = { header: m[1].toUpperCase(), lines: [] };
      sections.push(cur);
    } else if (cur && line.trim()) {
      cur.lines.push(line.trim());
    }
  }
  if (sections.length === 0) return [{ header: "", lines: text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) }];
  return sections;
}

/** Tách transcript thành từng dòng bong bóng, giữ NGUYÊN văn (gồm cả biến thể
 *  ASR "[V1]: ...", "[V2]: ..."). Dòng không có tiền tố speaker được coi là nối
 *  tiếp người nói của dòng trước (vd "[V2]:" sau "Customer: [V1]:") → đúng phía. */
function parseTranscript(text: string): { isCustomer: boolean; text: string }[] {
  if (!text) return [];
  const out: { isCustomer: boolean; text: string }[] = [];
  let lastIsCustomer = true; // dòng đầu chưa rõ speaker → coi là khách
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    const m = l.match(/^(Customer|Agent|Khách|ĐTV|Bot|AI)\s*:\s*(.*)$/i);
    if (m) {
      lastIsCustomer = /customer|khách/i.test(m[1]);
      out.push({ isCustomer: lastIsCustomer, text: m[2] });
    } else {
      out.push({ isCustomer: lastIsCustomer, text: l });
    }
  }
  return out;
}

/** Suy ra một trường (tên / SĐT) từ phần KEY INFORMATION của summary khi payload
 *  không có field cấu trúc tương ứng. Dùng làm fallback hiển thị. */
function deriveFromSummary(summary: string, labels: string[]): string {
  if (!summary) return "";
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:：]\\s*(.+)`, "i");
    const m = summary.match(re);
    if (m) return m[1].split(/\r?\n/)[0].trim();
  }
  return "";
}

function timeStr(epoch: number): string {
  try {
    return new Date(epoch * 1000).toLocaleTimeString("vi-VN");
  } catch {
    return "";
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

type Tone = "neg" | "neu" | "pos";
function sentimentInfo(value: string): { label: string; tone: Tone; pct: number; raw: string } {
  const num = Number(value);
  if (Number.isNaN(num)) {
    return { label: value || "—", tone: "neu", pct: 50, raw: value };
  }
  const pct = Math.max(0, Math.min(100, ((num + 1) / 2) * 100));
  if (num < -0.2) return { label: "Tiêu cực", tone: "neg", pct, raw: num.toFixed(2) };
  if (num > 0.2) return { label: "Tích cực", tone: "pos", pct, raw: num.toFixed(2) };
  return { label: "Trung lập", tone: "neu", pct, raw: num.toFixed(2) };
}

const TONE_CLS: Record<Tone, { text: string; bg: string; bar: string; ring: string }> = {
  neg: { text: "text-red-700", bg: "bg-red-50", bar: "bg-red-500", ring: "ring-red-200" },
  neu: { text: "text-amber-700", bg: "bg-amber-50", bar: "bg-amber-500", ring: "ring-amber-200" },
  pos: { text: "text-emerald-700", bg: "bg-emerald-50", bar: "bg-emerald-500", ring: "ring-emerald-200" },
};

// ── Sub-components ─────────────────────────────────────────────────────────

function Avatar({ name, tone, size = "md" }: { name: string; tone: Tone; size?: "sm" | "md" | "lg" }) {
  const dim = size === "lg" ? "h-12 w-12 text-base" : size === "sm" ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm";
  const ring = TONE_CLS[tone].ring;
  return (
    <div
      className={`flex ${dim} shrink-0 items-center justify-center rounded-full bg-blue-800 font-semibold text-white ring-2 ${ring}`}
      aria-hidden="true"
    >
      {initials(name)}
    </div>
  );
}

function SentimentGauge({ value }: { value: string }) {
  const s = sentimentInfo(value);
  const c = TONE_CLS[s.tone];
  return (
    <div className={`min-w-[140px] rounded-lg ${c.bg} px-3 py-2`}>
      <div className="mb-1 flex items-center justify-between">
        <span className={`flex items-center gap-1 text-xs font-semibold ${c.text}`}>
          <Activity className="h-3.5 w-3.5" /> {s.label}
        </span>
        <span className={`text-xs font-mono font-semibold ${c.text}`}>{s.raw}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/70">
        <div className={`h-full rounded-full ${c.bar} transition-all duration-300`} style={{ width: `${s.pct}%` }} />
      </div>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {icon} {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-sm font-semibold text-slate-800" title={value}>
        {value || "—"}
      </div>
    </div>
  );
}

function SummaryLine({ text }: { text: string }) {
  const bullet = /^[-•*]\s*/.test(text);
  if (bullet) {
    return (
      <li className="flex gap-2 text-sm leading-relaxed text-slate-700">
        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
        <span>{text.replace(/^[-•*]\s*/, "")}</span>
      </li>
    );
  }
  return <p className="text-sm leading-relaxed text-slate-700">{text}</p>;
}

function HandoffDetail({ ev }: { ev: HandoffEvent }) {
  const p = ev.payload || {};
  const extension = pick(p, ["extension", "destination", "ext"]);
  const callId = pick(p, ["call_id", "callId", "workflow_run_id", "id"]);
  const tier = pick(p, ["tier", "rank", "segment"]);
  const intent = pick(p, ["intent", "reason_code", "topic"]);
  const sentiment = pick(p, ["sentiment", "sentiment_score", "emotion"]);
  const summary = pick(p, ["summary", "ai_summary", "handoff_summary"]);
  const transcript = pick(p, ["transcript", "partial_transcript", "conversation"]);
  // Field cấu trúc ưu tiên; nếu trống thì suy ra từ KEY INFORMATION của summary.
  const customer =
    pick(p, ["customer", "customer_name", "name", "caller"]) ||
    deriveFromSummary(summary, ["Tên khách hàng", "Khách hàng", "Họ tên", "Tên"]);
  const phone =
    pick(p, ["phone", "phone_number", "msisdn"]) ||
    deriveFromSummary(summary, ["Số điện thoại", "SĐT", "Điện thoại", "Số liên hệ"]);

  const sections = useMemo(() => parseSummary(summary), [summary]);
  const turns = useMemo(() => parseTranscript(transcript), [transcript]);
  const tone = sentimentInfo(sentiment).tone;

  const known = new Set([
    "extension", "destination", "ext", "call_id", "callId", "workflow_run_id", "id",
    "customer", "customer_name", "name", "caller", "phone", "phone_number", "msisdn",
    "tier", "rank", "segment", "intent", "reason_code", "topic", "sentiment",
    "sentiment_score", "emotion", "summary", "ai_summary", "handoff_summary",
    "transcript", "partial_transcript", "conversation",
  ]);
  const extras = Object.entries(p).filter(([k, v]) => !known.has(k) && v !== null && v !== "");

  return (
    <div className="space-y-4">
      {/* Hồ sơ khách hàng */}
      <div className="flex items-center gap-3">
        <Avatar name={customer || "?"} tone={tone} size="lg" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-bold text-slate-900">{customer || "Khách chưa định danh"}</h2>
            {tier && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                <Crown className="h-3 w-3" /> {tier}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
            {phone && <span className="flex items-center gap-1"><PhoneCall className="h-3 w-3" /> {phone}</span>}
            {extension && <span className="flex items-center gap-1"><Hash className="h-3 w-3" /> Ext {extension}</span>}
            {intent && (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 font-medium text-blue-700">
                <Tag className="h-3 w-3" /> {intent}
              </span>
            )}
          </div>
        </div>
        {sentiment && <div className="ml-auto"><SentimentGauge value={sentiment} /></div>}
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard icon={<FileText className="h-3.5 w-3.5" />} label="Mã cuộc gọi" value={callId} />
        <StatCard icon={<Hash className="h-3.5 w-3.5" />} label="Số máy nhánh" value={extension} />
        <StatCard icon={<PhoneCall className="h-3.5 w-3.5" />} label="Số điện thoại" value={phone} />
        <StatCard icon={<Clock className="h-3.5 w-3.5" />} label="Tiếp nhận" value={timeStr(ev.received_at)} />
      </div>

      {/* Tóm tắt AI */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <header className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 text-sm font-bold text-slate-700">
          <FileText className="h-4 w-4 text-blue-700" /> Tóm tắt hội thoại (AI)
        </header>
        {summary ? (
          <div className="divide-y divide-slate-100">
            {sections.map((s, i) => {
              const meta = SECTION_META[s.header];
              return (
                <div key={i} className="px-4 py-3">
                  {s.header && meta && (
                    <div className={`mb-1.5 flex items-center gap-1.5 border-l-2 pl-2 text-xs font-bold uppercase tracking-wide ${meta.accent}`}>
                      {meta.icon} {meta.label}
                    </div>
                  )}
                  <ul className="space-y-1">
                    {s.lines.map((ln, j) => <SummaryLine key={j} text={ln} />)}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="px-4 py-6 text-center text-sm text-slate-400">Đang chờ AI sinh tóm tắt…</p>
        )}
      </section>

      {/* Transcript một phần */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <header className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 text-sm font-bold text-slate-700">
          <MessagesSquare className="h-4 w-4 text-blue-700" /> Transcript một phần
        </header>
        {turns.length ? (
          <div className="max-h-72 space-y-3 overflow-y-auto px-4 py-3">
            {turns.map((t, i) => (
              <div key={i} className={`flex items-end gap-2 ${t.isCustomer ? "justify-start" : "flex-row-reverse"}`}>
                <div
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                    t.isCustomer ? "bg-slate-200 text-slate-600" : "bg-blue-700 text-white"
                  }`}
                  aria-hidden="true"
                >
                  {t.isCustomer ? "KH" : "AI"}
                </div>
                <div
                  className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                    t.isCustomer
                      ? "rounded-bl-sm bg-slate-100 text-slate-800"
                      : "rounded-br-sm bg-blue-700 text-white"
                  }`}
                >
                  {t.text}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-4 py-6 text-center text-sm text-slate-400">Chưa có transcript.</p>
        )}
      </section>

      {/* Dữ liệu khác */}
      {extras.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Dữ liệu khác</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {extras.map(([k, v]) => (
              <StatCard key={k} icon={<ChevronRight className="h-3.5 w-3.5" />} label={k} value={typeof v === "object" ? JSON.stringify(v) : String(v)} />
            ))}
          </div>
        </section>
      )}

      <details className="text-xs text-slate-500">
        <summary className="cursor-pointer select-none rounded px-1 py-0.5 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300">
          Payload thô (JSON)
        </summary>
        <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
          {JSON.stringify(ev.payload, null, 2)}
        </pre>
      </details>
    </div>
  );
}

// ── Root ───────────────────────────────────────────────────────────────────

export default function SapDesk() {
  const [items, setItems] = useState<HandoffEvent[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pop, setPop] = useState<HandoffEvent | null>(null);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => new Date().toLocaleTimeString("vi-VN"));
  const seen = useRef<Set<string>>(new Set());

  // Đồng hồ header.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toLocaleTimeString("vi-VN")), 1000);
    return () => clearInterval(t);
  }, []);

  // Nạp lịch sử + mở SSE.
  useEffect(() => {
    fetch("/api/handoff/list")
      .then((r) => r.json())
      .then((d) => {
        const list: HandoffEvent[] = d.items || [];
        list.forEach((e) => seen.current.add(e.id));
        setItems(list);
        if (list[0]) setActiveId(list[0].id);
      })
      .catch(() => {});

    const es = new EventSource("/api/handoff/stream");
    es.onmessage = (msg) => {
      try {
        const ev: HandoffEvent = JSON.parse(msg.data);
        if (seen.current.has(ev.id)) return;
        seen.current.add(ev.id);
        setItems((prev) => [ev, ...prev]);
        setActiveId(ev.id);
        setPop(ev);
      } catch {
        /* keep-alive */
      }
    };
    return () => es.close();
  }, []);

  const active = items.find((e) => e.id === activeId) || null;
  const waiting = items.filter((e) => !answered.has(e.id)).length;

  const answer = (id: string) => {
    setAnswered((s) => new Set(s).add(id));
    setPop(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Header */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-blue-950 bg-[#0a2540] px-4 text-white sm:px-6">
        <div className="flex items-center gap-3">
          <div className="rounded bg-white/10 px-2 py-1 text-sm font-black tracking-[0.2em]">SAP</div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Agent Desk · Trung tâm Tổng đài</div>
            <div className="text-[11px] text-white/55">Warm Transfer Inbox · Poptech</div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="hidden font-mono text-white/70 sm:inline" aria-label="Giờ hiện tại">{now}</span>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 p-4 lg:grid-cols-[320px_1fr]">
        {/* Hàng đợi */}
        <aside className="h-fit rounded-xl border border-slate-200 bg-white lg:sticky lg:top-[72px]">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Hàng đợi chuyển tiếp</span>
            {waiting > 0 && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-700 px-1.5 text-[11px] font-bold text-white">
                {waiting}
              </span>
            )}
          </div>
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-sm text-slate-400">
              <Inbox className="h-8 w-8" /> Đang chờ AI chuyển tiếp…
            </div>
          ) : (
            <ul className="max-h-[calc(100vh-140px)] overflow-y-auto p-2">
              {items.map((e) => {
                const ext = pick(e.payload, ["extension", "destination", "ext"]);
                const summ = pick(e.payload, ["summary", "ai_summary", "handoff_summary"]);
                const cust =
                  pick(e.payload, ["customer", "customer_name", "name"]) ||
                  deriveFromSummary(summ, ["Tên khách hàng", "Khách hàng", "Họ tên", "Tên"]) ||
                  `Ext ${ext || "?"}`;
                const intent = pick(e.payload, ["intent", "reason_code", "topic"]);
                const tone = sentimentInfo(pick(e.payload, ["sentiment", "sentiment_score", "emotion"])).tone;
                const isAns = answered.has(e.id);
                const isActive = activeId === e.id;
                return (
                  <li key={e.id}>
                    <button
                      onClick={() => setActiveId(e.id)}
                      className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 ${
                        isActive ? "bg-blue-50 ring-1 ring-blue-200" : "hover:bg-slate-50"
                      }`}
                    >
                      <div className="relative">
                        <Avatar name={cust} tone={tone} size="sm" />
                        {!isAns && (
                          <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-blue-600 ring-2 ring-white" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-slate-800">{cust}</div>
                        <div className="truncate text-xs text-slate-400">{intent || `Cuộc gọi ${ext}`}</div>
                      </div>
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="font-mono text-[10px] text-slate-400">{timeStr(e.received_at)}</span>
                        {isAns ? (
                          <span className="text-[10px] font-semibold text-emerald-600">đã nhấc</span>
                        ) : (
                          <span className="text-[10px] font-semibold text-blue-600">MỚI</span>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        {/* Chi tiết */}
        <main className="min-w-0 rounded-xl border border-slate-200 bg-slate-50/60 p-4 sm:p-5">
          {active ? (
            <>
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-400">
                  <PhoneIncoming className="h-4 w-4 text-blue-700" /> Ngữ cảnh cuộc gọi
                </div>
                {!answered.has(active.id) && (
                  <button
                    onClick={() => answer(active.id)}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors duration-150 hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
                  >
                    <PhoneCall className="h-4 w-4" /> Nhấc máy
                  </button>
                )}
              </div>
              <HandoffDetail ev={active} />
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 py-24 text-slate-400">
              <PhoneIncoming className="h-10 w-10" />
              <p className="text-sm">Chưa có cuộc gọi nào được chuyển đến.</p>
            </div>
          )}
        </main>
      </div>

      {/* Screen-pop */}
      {pop && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Cuộc gọi chuyển đến"
        >
          <div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5">
            <div className="flex items-center justify-between bg-[#0a2540] px-5 py-4 text-white">
              <div className="flex items-center gap-3">
                <span className="relative flex h-3 w-3" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
                </span>
                <div className="leading-tight">
                  <div className="text-sm font-bold tracking-wide">CUỘC GỌI CHUYỂN ĐẾN</div>
                  <div className="text-[11px] text-white/55">
                    Ext {pick(pop.payload, ["extension", "destination", "ext"]) || "?"} · {timeStr(pop.received_at)}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setPop(null)}
                aria-label="Đóng"
                className="cursor-pointer rounded-lg p-1.5 transition-colors duration-150 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[70vh] overflow-y-auto p-5">
              <HandoffDetail ev={pop} />
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
              <button
                onClick={() => setPop(null)}
                className="cursor-pointer rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 transition-colors duration-150 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
              >
                Để sau
              </button>
              <button
                onClick={() => answer(pop.id)}
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors duration-150 hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
              >
                <PhoneCall className="h-4 w-4" /> Nhấc máy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
