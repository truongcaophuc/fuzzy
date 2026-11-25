// HTML template for the SAP Desk call detail (pure: no DOM, no React).
//
// Anyone can paste HTML + CSS in the desk's "Tùy chỉnh giao diện" editor; the values come from the
// Dograh handoff payload. Those values are partly what the CUSTOMER said (transcript, summary written
// by the LLM from the call), so they are always HTML-escaped: there is no syntax to insert raw HTML.
// The result is shown in a sandboxed iframe without scripts (see buildDocument), so even a <script>
// pasted into the template does not run.
//
// Template syntax (a Mustache subset):
//   {{key}}                  the value, escaped ("" when missing)
//   {{#key}} … {{.}} … {{/key}}  a list repeats the block once per item ({{.}} = the item; for a list
//                            of records such as `turns`, the record's own keys: {{side}}, {{text}});
//                            a non-empty single value shows the block once ({{.}} = the value)
//   {{^key}} … {{/key}}      the block only when key is empty / missing

export type TemplateRecord = Record<string, string>;
export type TemplateValue = string | string[] | TemplateRecord[];
export type TemplateData = Record<string, TemplateValue>;

// Headers the Dograh summary prompt asks for, and the keys they become when the payload does not
// already carry them as structured handoff fields. "Likelyhood to Buy: 4" (the prompt's spelling)
// is read as the loan likelihood score.
const SECTIONS: Record<string, string> = {
  REASON: "reason",
  "AGENT ACTIONS": "agent_actions",
  RESOLUTION: "resolution",
  "KEY INFORMATION": "key_info",
  "LIKELYHOOD TO BUY": "loan_likelihood",
  "LIKELIHOOD TO BUY": "loan_likelihood",
  "KHẢ NĂNG VAY": "loan_likelihood",
};
// Keys that are lists: a string value is split into its non-empty lines (bullets stripped).
const LIST_KEYS = new Set(["agent_actions", "key_info", "transcript"]);

export const LIKELIHOOD_LABELS = ["Rất thấp", "Thấp", "Trung bình", "Cao", "Rất cao"];

const stripBullet = (line: string) => line.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "").trim();
const toLines = (text: string) => text.split(/\r?\n/).map(stripBullet).filter(Boolean);

/** Sections of a free-text summary written with the REASON / AGENT ACTIONS / … headers. */
export function summarySections(summary: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const header = new RegExp(`^\\s*(${Object.keys(SECTIONS).join("|")})\\s*:?\\s*(.*)$`, "i");
  let cur: string | null = null;
  for (const line of summary.split(/\r?\n/)) {
    const m = line.match(header);
    if (m) {
      cur = SECTIONS[m[1].toUpperCase()];
      out[cur] = m[2].trim() ? [stripBullet(m[2])] : [];
    } else if (cur && line.trim()) {
      out[cur].push(stripBullet(line));
    }
  }
  return out;
}

/** The 1–5 loan likelihood from a field value or a summary line ("4", "4/5", "Mức 4 - Cao"); null if none. */
export function likelihoodLevel(value: unknown): number | null {
  const m = String(value ?? "").match(/[1-5]/);
  return m ? Number(m[0]) : null;
}

/** One transcript line as a chat turn: who spoke ("customer" | "bot") and what. */
function toTurns(lines: string[]): TemplateRecord[] {
  let side = "customer";
  return lines.map((line) => {
    const m = line.match(/^(Customer|Khách|KH|Agent|Bot|AI|ĐTV)\s*:\s*(.*)$/i);
    if (m) side = /customer|khách|kh/i.test(m[1]) ? "customer" : "bot";
    return { side, who: side === "customer" ? "KH" : "AI", text: m ? m[2] : line };
  });
}

/**
 * Values a template can use:
 * - every payload key (objects as JSON);
 * - `reason`, `agent_actions`, `resolution`, `key_info` and `loan_likelihood` taken from the summary
 *   when the payload has no such field (structured handoff fields always win);
 * - `loan_likelihood` normalized to 1–5 with `loan_likelihood_label` ("Cao");
 * - `sentiment_label` / `sentiment_tone` (pos | neu | neg) / `sentiment_pct` (0–100) from a −1…1 sentiment;
 * - `initials` of the customer, `turns` (transcript as {side, who, text}), `received_at` as a time;
 * - `summary_headline`: the summary when it is a short headline next to structured fields.
 */
export function templateData(payload: Record<string, unknown>, receivedAt?: number): TemplateData {
  const data: TemplateData = {};
  for (const [k, v] of Object.entries(payload || {})) {
    if (v === null || v === undefined) continue;
    const text = typeof v === "object" ? JSON.stringify(v) : String(v);
    data[k] = Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))) : text;
  }
  const summary = typeof payload?.summary === "string" ? payload.summary : "";
  const sections = summarySections(summary);
  for (const [key, lines] of Object.entries(sections)) {
    if (data[key] === undefined || data[key] === "") data[key] = LIST_KEYS.has(key) ? lines : lines.join(" ");
  }
  for (const key of LIST_KEYS) {
    const v = data[key];
    if (typeof v === "string") data[key] = toLines(v);
  }

  const level = likelihoodLevel(data.loan_likelihood);
  if (level) {
    data.loan_likelihood = String(level);
    data.loan_likelihood_label = LIKELIHOOD_LABELS[level - 1];
  } else {
    delete data.loan_likelihood;
  }

  const mood = Number(data.sentiment);
  if (typeof data.sentiment === "string" && data.sentiment.trim() !== "" && !Number.isNaN(mood)) {
    data.sentiment = mood.toFixed(2);
    data.sentiment_pct = String(Math.round(Math.max(0, Math.min(100, ((mood + 1) / 2) * 100))));
    data.sentiment_tone = mood < -0.2 ? "neg" : mood > 0.2 ? "pos" : "neu";
    data.sentiment_label = mood < -0.2 ? "Tiêu cực" : mood > 0.2 ? "Tích cực" : "Trung lập";
  }

  const name = typeof data.customer === "string" ? data.customer.trim() : "";
  if (name) {
    const parts = name.split(/\s+/);
    data.initials = (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  if (Array.isArray(data.transcript)) data.turns = toTurns(data.transcript as string[]);
  // A summary written with the section headers is already shown section by section.
  if (summary.trim() && Object.keys(sections).length === 0) data.summary_headline = summary.trim();
  if (receivedAt) data.received_at = new Date(receivedAt * 1000).toLocaleTimeString("vi-VN");
  return data;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const isEmpty = (v: TemplateValue | undefined) => v === undefined || (Array.isArray(v) ? v.length === 0 : v.trim() === "");

const TAG = /\{\{\s*([#^/]?)\s*(\.|[\w.-]+)\s*\}\}/g;

/**
 * Fills a template with data; every value is escaped. Unknown keys render as "". Sections nest,
 * including a section inside one of the same key ("show the card only when there are actions,
 * then list them"): {{#agent_actions}}<ul>{{#agent_actions}}<li>{{.}}</li>{{/agent_actions}}</ul>{{/agent_actions}}.
 * An unclosed section renders as plain text.
 */
const asText = (v: TemplateValue | undefined): string =>
  v === undefined ? "" : typeof v === "string" ? v : v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ");

export function renderTemplate(template: string, data: TemplateData, item?: string): string {
  let out = "";
  let pos = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(template); m; m = TAG.exec(template)) {
    const [tag, kind, key] = m;
    out += template.slice(pos, m.index);
    pos = m.index + tag.length;
    if (kind === "") {
      out += escapeHtml(key === "." ? item ?? "" : asText(data[key]));
      continue;
    }
    if (kind === "/") continue; // a stray closing tag
    // Find the matching close, counting nested sections of the same key.
    const close = new RegExp(`\\{\\{\\s*([#^/])\\s*${key.replace(/[.-]/g, "\\$&")}\\s*\\}\\}`, "g");
    close.lastIndex = pos;
    let depth = 1;
    let end: RegExpExecArray | null = null;
    for (let c = close.exec(template); c; c = close.exec(template)) {
      depth += c[1] === "/" ? -1 : 1;
      if (depth === 0) { end = c; break; }
    }
    if (!end) { out += escapeHtml(tag); continue; }
    const inner = template.slice(pos, end.index);
    pos = end.index + end[0].length;
    TAG.lastIndex = pos;
    const v = data[key];
    if (kind === "^") {
      if (isEmpty(v)) out += renderTemplate(inner, data, item);
    } else if (!isEmpty(v)) {
      const items: (string | TemplateRecord)[] = Array.isArray(v) ? v : [v];
      // A list section repeats; a single value (or the list as a whole, when the block is just a
      // guard around another section of the same key) shows the block once. A record item lends
      // its keys to the block ({{side}}, {{text}}).
      const guard = Array.isArray(v) && new RegExp(`\\{\\{\\s*#\\s*${key.replace(/[.-]/g, "\\$&")}\\s*\\}\\}`).test(inner);
      out += guard
        ? renderTemplate(inner, data, item)
        : items.map((x) => (typeof x === "string" ? renderTemplate(inner, data, x) : renderTemplate(inner, { ...data, ...x }))).join("");
    }
    TAG.lastIndex = pos;
  }
  return out + template.slice(pos);
}

// No scripts, no network: only inline styles and data: images/fonts. Together with the iframe's
// sandbox (no allow-scripts) a template cannot run code or call out to another server.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** A full HTML document for the iframe's srcdoc. */
export function buildDocument(bodyHtml: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>html,body{margin:0}body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a;background:transparent}</style>
</head><body>${bodyHtml}</body></html>`;
}

/**
 * Starter template: the desk layout while no template is saved, and where the editor starts from
 * (profile, likelihood bar, KPIs, summary by section, transcript as chat turns), in plain HTML + CSS.
 */
export const STARTER_TEMPLATE = `<style>
  :root { --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --brand: #1d4ed8; }
  * { box-sizing: border-box; }
  body { padding: 2px; }
  svg { width: 16px; height: 16px; flex: none; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 14px; margin-bottom: 14px; }

  /* Hồ sơ khách */
  .profile { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
  .avatar { width: 48px; height: 48px; border-radius: 50%; background: #1e3a8a; color: #fff; display: grid; place-items: center; font-weight: 700; flex: none; box-shadow: 0 0 0 3px #fde68a; }
  .avatar[data-tone="pos"] { box-shadow: 0 0 0 3px #a7f3d0; }
  .avatar[data-tone="neg"] { box-shadow: 0 0 0 3px #fecaca; }
  .who h2 { margin: 0; font-size: 19px; }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; color: var(--muted); font-size: 13px; margin-top: 2px; }
  .meta span { display: inline-flex; align-items: center; gap: 4px; }
  .meta svg { width: 13px; height: 13px; }
  .chip { background: #dbeafe; color: var(--brand); border-radius: 999px; padding: 1px 10px; font-weight: 600; }
  .mood { margin-left: auto; min-width: 150px; border-radius: 10px; padding: 8px 12px; background: #fffbeb; color: #b45309; }
  .mood[data-tone="pos"] { background: #ecfdf5; color: #047857; }
  .mood[data-tone="neg"] { background: #fef2f2; color: #b91c1c; }
  .mood-top { display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; }
  .mood-top b { font-family: ui-monospace, monospace; }
  .mood-track { height: 6px; border-radius: 99px; background: rgba(255,255,255,.8); margin-top: 6px; overflow: hidden; }
  .mood-track i { display: block; height: 100%; border-radius: 99px; background: currentColor; }

  /* Khả năng vay: 5 mức, tô màu tới mức đạt được */
  .likely { padding: 14px 16px; }
  .likely-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .likely-score { font-size: 13px; color: var(--muted); }
  .likely-score b { font-size: 22px; color: var(--ink); }
  .likely-bar { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
  .likely-bar i { height: 10px; border-radius: 6px; background: #e2e8f0; }
  .likely-scale { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-top: 6px; font-size: 11px; color: var(--muted); text-align: center; }
  .likely[data-level="1"] .likely-bar i:nth-child(-n+1) { background: #ef4444; }
  .likely[data-level="2"] .likely-bar i:nth-child(-n+2) { background: #f97316; }
  .likely[data-level="3"] .likely-bar i:nth-child(-n+3) { background: #eab308; }
  .likely[data-level="4"] .likely-bar i:nth-child(-n+4) { background: #22c55e; }
  .likely[data-level="5"] .likely-bar i:nth-child(-n+5) { background: #059669; }
  .likely[data-level="1"] .likely-scale span:nth-child(1),
  .likely[data-level="2"] .likely-scale span:nth-child(2),
  .likely[data-level="3"] .likely-scale span:nth-child(3),
  .likely[data-level="4"] .likely-scale span:nth-child(4),
  .likely[data-level="5"] .likely-scale span:nth-child(5) { color: var(--ink); font-weight: 700; }

  /* Số liệu */
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px; }
  .kpi { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; min-width: 0; }
  .kpi small { display: flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #94a3b8; }
  .kpi small svg { width: 12px; height: 12px; }
  .kpi b { display: block; margin-top: 2px; font: 600 14px ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Tóm tắt theo mục */
  .card > header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #f1f5f9; font-weight: 700; color: #334155; }
  .card > header svg { color: var(--brand); }
  .headline { margin: 0; padding: 12px 16px; border-bottom: 1px solid #f1f5f9; }
  .sec { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; }
  .sec:last-child { border-bottom: 0; }
  .sec-title { display: flex; align-items: center; gap: 6px; border-left: 2px solid; padding-left: 8px; margin-bottom: 6px; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
  .sec-title svg { width: 15px; height: 15px; }
  .sec p { margin: 0; }
  .sec ul { margin: 0; padding: 0; list-style: none; }
  .sec li { position: relative; padding-left: 16px; margin: 3px 0; }
  .sec li::before { content: ""; position: absolute; left: 2px; top: .62em; width: 6px; height: 6px; border-radius: 50%; background: #cbd5e1; }
  .reason .sec-title { color: #1d4ed8; border-color: #3b82f6; }
  .actions .sec-title { color: #4338ca; border-color: #6366f1; }
  .resolution .sec-title { color: #047857; border-color: #10b981; }
  .keyinfo .sec-title { color: #b45309; border-color: #f59e0b; }

  /* Transcript */
  .turns { padding: 12px 16px; display: grid; gap: 10px; }
  .turn { display: flex; align-items: flex-end; gap: 8px; }
  .turn.bot { flex-direction: row-reverse; }
  .turn span { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; font-weight: 700; background: #e2e8f0; color: #475569; flex: none; }
  .turn.bot span { background: var(--brand); color: #fff; }
  .turn p { margin: 0; max-width: 78%; padding: 8px 12px; border-radius: 16px 16px 16px 4px; background: #f1f5f9; }
  .turn.bot p { border-radius: 16px 16px 4px 16px; background: var(--brand); color: #fff; }
</style>

<div class="profile">
  <div class="avatar" data-tone="{{sentiment_tone}}">{{initials}}{{^initials}}?{{/initials}}</div>
  <div class="who">
    <h2>{{customer}}{{^customer}}Khách chưa định danh{{/customer}}</h2>
    <div class="meta">
      {{#phone}}<span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>{{phone}}</span>{{/phone}}
      {{#extension}}<span># Ext {{extension}}</span>{{/extension}}
      {{#intent}}<span class="chip">{{intent}}</span>{{/intent}}
    </div>
  </div>
  {{#sentiment_label}}
  <div class="mood" data-tone="{{sentiment_tone}}">
    <div class="mood-top"><span>{{sentiment_label}}</span><b>{{sentiment}}</b></div>
    <div class="mood-track"><i style="width: {{sentiment_pct}}%"></i></div>
  </div>
  {{/sentiment_label}}
</div>

{{#loan_likelihood}}
<div class="card likely" data-level="{{loan_likelihood}}">
  <div class="likely-head">
    <div class="sec-title" style="color:#0f766e;border-color:#14b8a6;margin:0"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>Khả năng vay</div>
    <div class="likely-score"><b>{{loan_likelihood}}</b>/5 · {{loan_likelihood_label}}</div>
  </div>
  <div class="likely-bar"><i></i><i></i><i></i><i></i><i></i></div>
  <div class="likely-scale"><span>Rất thấp</span><span>Thấp</span><span>Trung bình</span><span>Cao</span><span>Rất cao</span></div>
</div>
{{/loan_likelihood}}

<div class="kpis">
  <div class="kpi"><small>Mã cuộc gọi</small><b>{{call_id}}{{^call_id}}—{{/call_id}}</b></div>
  <div class="kpi"><small>Số máy nhánh</small><b>{{extension}}{{^extension}}—{{/extension}}</b></div>
  <div class="kpi"><small>Số điện thoại</small><b>{{phone}}{{^phone}}—{{/phone}}</b></div>
  <div class="kpi"><small>Tiếp nhận</small><b>{{received_at}}{{^received_at}}—{{/received_at}}</b></div>
</div>

<section class="card">
  <header><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>Tóm tắt hội thoại (AI)</header>
  {{#summary_headline}}<p class="headline">{{summary_headline}}</p>{{/summary_headline}}
  {{#reason}}
  <div class="sec reason">
    <div class="sec-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>Vấn đề liên hệ</div>
    <p>{{reason}}</p>
  </div>
  {{/reason}}
  {{#agent_actions}}
  <div class="sec actions">
    <div class="sec-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>BOT đã hỗ trợ</div>
    <ul>{{#agent_actions}}<li>{{.}}</li>{{/agent_actions}}</ul>
  </div>
  {{/agent_actions}}
  {{#resolution}}
  <div class="sec resolution">
    <div class="sec-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>Hướng xử lý</div>
    <p>{{resolution}}</p>
  </div>
  {{/resolution}}
  {{#key_info}}
  <div class="sec keyinfo">
    <div class="sec-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.59 17.41A2 2 0 0 0 2 18.83V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.17a2 2 0 0 0 1.42-.59l.81-.81a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>Thông tin then chốt</div>
    <ul>{{#key_info}}<li>{{.}}</li>{{/key_info}}</ul>
  </div>
  {{/key_info}}
</section>

{{#turns}}
<section class="card">
  <header><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Transcript một phần</header>
  <div class="turns">{{#turns}}<div class="turn {{side}}"><span>{{who}}</span><p>{{text}}</p></div>{{/turns}}</div>
</section>
{{/turns}}
`;

/** Payload used for the editor preview while no call has been handed off yet. */
export const SAMPLE_PAYLOAD: Record<string, unknown> = {
  call_id: "1773",
  extension: "1021",
  customer: "Nguyễn Văn A",
  phone: "0912345678",
  intent: "Dự toán vay mua Vios",
  sentiment: "0.4",
  loan_likelihood: "4",
  summary:
    "REASON:\nKhách muốn dự toán khoản vay mua Toyota Vios.\nAGENT ACTIONS:\n- Hỏi mẫu xe và giá xe\n- Tính trả trước 20%, kỳ hạn 60 tháng\n- Giới thiệu gói Balloon\nRESOLUTION:\nChuyển chuyên viên tư vấn hồ sơ vay.\nKEY INFORMATION:\n- Mẫu xe: Vios 1.5G\n- Trả trước: 20%\n- Kỳ hạn: 60 tháng",
  transcript: "Customer: Tôi muốn hỏi vay mua xe Vios\nAgent: Dạ anh dự định trả trước bao nhiêu ạ?",
};
