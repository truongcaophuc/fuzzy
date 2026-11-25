import { useEffect, useMemo, useRef, useState } from "react";
import { PhoneIncoming, PhoneCall, X, Inbox, Trash2, Palette, Settings } from "lucide-react";
import {
  SAMPLE_PAYLOAD, STARTER_TEMPLATE, buildDocument, renderTemplate, templateData,
} from "./handoffTemplate";

// ── Poptech · Mô phỏng màn hình SAP của điện thoại viên ────────────────────
// Nhận warm-handoff từ Dograh qua SSE (/api/handoff/stream) và "screen-pop" ngữ
// cảnh cuộc gọi (tóm tắt AI + transcript + dữ liệu khách) TRƯỚC khi ĐTV nhấc máy.

interface HandoffEvent {
  id: string;
  received_at: number;
  payload: Record<string, unknown>;
}

/** Lấy field đầu tiên tồn tại trong payload (hỗ trợ nhiều tên khoá). */
function pick(payload: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = payload?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return "";
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

/** The call detail drawn from a user template: sandboxed (no scripts, no network), sized to its content. */
function TemplateFrame({ template, ev, title }: { template: string; ev: HandoffEvent; title: string }) {
  const doc = useMemo(
    () => buildDocument(renderTemplate(template, templateData(ev.payload || {}, ev.received_at))),
    [template, ev],
  );
  const frame = useRef<HTMLIFrameElement>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const [height, setHeight] = useState(240);
  useEffect(() => () => observer.current?.disconnect(), []);
  const fit = () => {
    const root = frame.current?.contentDocument?.documentElement;
    if (root) setHeight(Math.max(80, root.scrollHeight));
  };
  return (
    <iframe
      ref={frame}
      title={title}
      // allow-same-origin without allow-scripts: nothing in the template runs; the desk can still
      // read the content height to size the frame.
      sandbox="allow-same-origin"
      srcDoc={doc}
      onLoad={() => {
        fit();
        observer.current?.disconnect();
        const body = frame.current?.contentDocument?.body;
        if (body && "ResizeObserver" in window) {
          observer.current = new ResizeObserver(fit);
          observer.current.observe(body);
        }
      }}
      style={{ height }}
      className="block w-full border-0 bg-transparent"
    />
  );
}

function RawPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <details className="text-xs text-slate-500">
      <summary className="cursor-pointer select-none rounded px-1 py-0.5 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300">
        Payload thô (JSON)
      </summary>
      <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </details>
  );
}

/** The call detail is always a template: the saved one, else the starter template. */
function HandoffDetail({ ev, template }: { ev: HandoffEvent; template: string }) {
  return (
    <div className="space-y-4">
      <TemplateFrame template={template.trim() || STARTER_TEMPLATE} ev={ev} title="Chi tiết cuộc gọi" />
      <RawPayload payload={ev.payload || {}} />
    </div>
  );
}

/**
 * Editor for the call-detail template: HTML on the left, live preview on the right (the call shown
 * in the desk, or a sample when there is none), the values it can use as clickable chips. It opens
 * on the template in use (the starter template while none is saved). Saving applies it to every open
 * desk; "Khôi phục mẫu gốc" drops the saved template so every desk goes back to the starter.
 */
// When the sample payload is previewed it is shown as received when the desk was opened.
const SAMPLE_RECEIVED_AT = Date.now() / 1000;

function TemplateEditor({ initial, previewEv, onClose }: { initial: string; previewEv: HandoffEvent | null; onClose: () => void }) {
  const inUse = initial.trim() || STARTER_TEMPLATE;
  const [html, setHtml] = useState(inUse);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const sample = useMemo<HandoffEvent>(
    () => previewEv ?? { id: "sample", received_at: SAMPLE_RECEIVED_AT, payload: SAMPLE_PAYLOAD },
    [previewEv],
  );
  const keys = useMemo(() => Object.keys(templateData(sample.payload, sample.received_at)).sort(), [sample]);
  const dirty = html !== inUse;
  const close = () => (!dirty || confirm("Bỏ các thay đổi chưa lưu?")) && onClose();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !dirty && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, onClose]);

  const insert = (text: string) => {
    const el = area.current;
    if (!el) return setHtml((h) => h + text);
    const { selectionStart: a, selectionEnd: b } = el;
    const next = html.slice(0, a) + text + html.slice(b);
    setHtml(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + text.length, a + text.length);
    });
  };

  const save = async (value: string) => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/handoff/template", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: value }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail || `HTTP ${r.status}`);
      onClose();
    } catch (e) {
      setError(`Lưu thất bại: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Tùy chỉnh giao diện chi tiết cuộc gọi">
      <div className="flex h-full max-h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5">
        <div className="flex items-center justify-between bg-[#0a2540] px-5 py-3 text-white">
          <div className="leading-tight">
            <div className="text-sm font-bold">Tùy chỉnh giao diện chi tiết cuộc gọi</div>
            <div className="text-[11px] text-white/60">
              HTML + CSS · dùng {"{{key}}"} cho giá trị, {"{{#list}}…{{.}}…{{/list}}"} để lặp, {"{{^key}}…{{/key}}"} khi trống · áp dụng cho mọi màn hình
            </div>
          </div>
          <button onClick={close} aria-label="Đóng" className="cursor-pointer rounded-lg p-1.5 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
          <div className="flex min-h-0 flex-col border-b border-slate-200 lg:border-b-0 lg:border-r">
            <div className="flex flex-wrap gap-1.5 border-b border-slate-100 px-4 py-2.5" aria-label="Giá trị có thể dùng">
              {keys.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => insert(`{{${k}}}`)}
                  title={`Chèn {{${k}}}`}
                  className="cursor-pointer rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[11px] text-slate-600 hover:border-blue-400 hover:text-blue-700"
                >
                  {k}
                </button>
              ))}
            </div>
            <label htmlFor="sap-template" className="sr-only">HTML của giao diện</label>
            <textarea
              id="sap-template"
              ref={area}
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              spellCheck={false}
              placeholder="Dán HTML vào đây. Lưu ô trống = dùng mẫu gốc."
              className="min-h-[240px] flex-1 resize-none p-4 font-mono text-[12.5px] leading-relaxed text-slate-800 outline-none"
            />
          </div>
          <div className="min-h-0 overflow-y-auto bg-slate-50 p-4">
            <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">
              Xem trước · {previewEv ? "cuộc gọi đang chọn" : "dữ liệu mẫu"}
            </div>
            <TemplateFrame template={html.trim() || STARTER_TEMPLATE} ev={sample} title="Xem trước giao diện" />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={() => confirm("Bỏ giao diện đã chỉnh và quay về mẫu gốc cho mọi màn hình?") && save("")}
            disabled={saving || !initial.trim()}
            className="cursor-pointer rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-200 disabled:cursor-default disabled:opacity-40"
          >
            Khôi phục mẫu gốc
          </button>
          {error && <span className="text-sm text-red-600" role="alert">{error}</span>}
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={close} className="cursor-pointer rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-200">
              Đóng
            </button>
            <button
              type="button"
              onClick={() => save(html)}
              disabled={saving || !dirty}
              className="cursor-pointer rounded-lg bg-blue-700 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-default disabled:opacity-40"
            >
              {saving ? "Đang lưu…" : "Lưu"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Root ───────────────────────────────────────────────────────────────────

export default function SapDesk() {
  const [items, setItems] = useState<HandoffEvent[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pop, setPop] = useState<HandoffEvent | null>(null);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  // Call-detail template shared by every desk ("" = the starter template), and whether its editor is open.
  const [template, setTemplate] = useState("");
  const [editing, setEditing] = useState(false);
  // The gear menu in the header (settings live there, not as loose header buttons).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const seen = useRef<Set<string>>(new Set());

  // Đóng menu bánh răng khi click ra ngoài / Esc.
  useEffect(() => {
    if (!settingsOpen) return;
    const close = () => setSettingsOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [settingsOpen]);

  // Đóng menu chuột phải khi click ra ngoài / cuộn / Esc.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  /** Bỏ các id khỏi state cục bộ (dùng cho cả xoá tại chỗ lẫn event SSE từ tab khác). */
  const removeLocal = (ids: string[] | "all") => {
    const gone = (id: string) => ids === "all" || ids.includes(id);
    setItems((prev) => {
      const next = prev.filter((e) => !gone(e.id));
      setActiveId((cur) => (cur && !gone(cur) ? cur : next[0]?.id ?? null));
      return next;
    });
    setPop((p) => (p && gone(p.id) ? null : p));
  };

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
    fetch("/api/handoff/template")
      .then((r) => r.json())
      .then((d) => setTemplate(typeof d.html === "string" ? d.html : ""))
      .catch(() => {});

    const es = new EventSource("/api/handoff/stream");
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === "template") return setTemplate(typeof data.html === "string" ? data.html : "");
        if (data.type === "deleted") return removeLocal(data.ids || []);
        if (data.type === "cleared") return removeLocal("all");
        const ev: HandoffEvent = data;
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

  const deleteOne = async (id: string) => {
    setMenu(null);
    const r = await fetch(`/api/handoff/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    if (r && (r.ok || r.status === 404)) removeLocal([id]);
    else alert("Xoá thất bại — kiểm tra kết nối backend.");
  };

  const deleteAll = async () => {
    setMenu(null);
    if (!confirm(`Xoá toàn bộ ${items.length} cuộc gọi trong hàng đợi?`)) return;
    const r = await fetch("/api/handoff", { method: "DELETE" }).catch(() => null);
    if (r?.ok) removeLocal("all");
    else alert("Xoá thất bại — kiểm tra kết nối backend.");
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
          <div className="relative">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setSettingsOpen((o) => !o);
              }}
              aria-label="Cài đặt"
              title="Cài đặt"
              aria-haspopup="menu"
              aria-expanded={settingsOpen}
              className={`inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${settingsOpen ? "bg-white/10 text-white" : ""}`}
            >
              <Settings className="h-[18px] w-[18px]" />
            </button>
            {settingsOpen && (
              <div
                role="menu"
                onClick={(e) => e.stopPropagation()}
                className="absolute right-0 top-[calc(100%+6px)] z-40 min-w-[210px] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-sm text-slate-700 shadow-lg"
              >
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setSettingsOpen(false);
                    setEditing(true);
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:outline-none"
                >
                  <Palette className="h-4 w-4 text-slate-500" /> Tùy chỉnh giao diện
                </button>
              </div>
            )}
          </div>
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
                      onContextMenu={(ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        setMenu({ x: ev.clientX, y: ev.clientY, id: e.id });
                      }}
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
              <HandoffDetail ev={active} template={template} />
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 py-24 text-slate-400">
              <PhoneIncoming className="h-10 w-10" />
              <p className="text-sm">Chưa có cuộc gọi nào được chuyển đến.</p>
            </div>
          )}
        </main>
      </div>

      {/* Menu chuột phải trên hàng đợi */}
      {menu && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          className="fixed z-40 min-w-[180px] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg"
          style={{
            left: Math.min(menu.x, window.innerWidth - 196),
            top: Math.min(menu.y, window.innerHeight - 88),
          }}
        >
          <button
            role="menuitem"
            onClick={() => deleteOne(menu.id)}
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-slate-700 hover:bg-slate-100"
          >
            <Trash2 className="h-4 w-4" /> Xoá cuộc gọi này
          </button>
          <button
            role="menuitem"
            onClick={deleteAll}
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50"
          >
            <Trash2 className="h-4 w-4" /> Xoá tất cả ({items.length})
          </button>
        </div>
      )}

      {editing && <TemplateEditor initial={template} previewEv={active} onClose={() => setEditing(false)} />}

      {/* Screen-pop */}
      {pop && !editing && (
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
              <HandoffDetail ev={pop} template={template} />
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
