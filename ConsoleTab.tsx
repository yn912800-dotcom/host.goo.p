"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button, Card, Input } from "@/components/ui";
import { CheckCircle2, Download, Pause, Play, Send, Smartphone, Trash } from "lucide-react";

type Log = {
  id: number;
  level: string;
  source: string;
  message: string;
  createdAt: string;
};

const QR = "[[QR]]";
const PAIR = "[[WA_PAIRING]]";
const CONNECTED = "[[WA_CONNECTED]]";

export default function ConsoleTab({ serverId }: { serverId: string }) {
  const [logs, setLogs] = useState<Log[]>([]);
  const [paused, setPaused] = useState(false);
  const [auto, setAuto] = useState(true);
  const [input, setInput] = useState("");
  const [inputErr, setInputErr] = useState<string | null>(null);
  const [qrImg, setQrImg] = useState<string | null>(null);
  const sinceRef = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop = false;
    const pull = async () => {
      if (paused || stop) return;
      try {
        if (sinceRef.current === 0) {
          const r = await fetch(`/api/servers/${serverId}/logs?limit=400`);
          const d = await r.json();
          if (!r.ok) return;
          const rows = (d.logs ?? []) as Log[];
          setLogs(rows);
          sinceRef.current = rows.reduce((m, l) => Math.max(m, l.id), 0) || -1;
          return;
        }
        const since = Math.max(sinceRef.current, 0);
        const r = await fetch(`/api/servers/${serverId}/logs?sinceId=${since}&limit=500`);
        const d = await r.json();
        if (!r.ok) return;
        const incoming = (d.logs ?? []) as Log[];
        if (incoming.length === 0) return;
        setLogs((prev) => [...prev, ...incoming].slice(-2000));
        sinceRef.current = Math.max(since, ...incoming.map((l) => l.id));
      } catch {}
    };
    pull();
    const t = setInterval(pull, 1500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [serverId, paused]);

  useEffect(() => {
    if (auto && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [logs, auto]);

  // WhatsApp linking state derived from the real process output
  const wa = useMemo(() => {
    let qr: Log | null = null;
    let pair: Log | null = null;
    let conn: Log | null = null;
    for (const l of logs) {
      if (l.message.startsWith(QR)) qr = l;
      else if (l.message.startsWith(PAIR)) pair = l;
      else if (l.message.includes(CONNECTED)) conn = l;
    }
    const last = Math.max(qr?.id ?? 0, pair?.id ?? 0);
    return {
      qr: qr && (!conn || qr.id > conn.id) && qr.id === last ? qr.message.slice(QR.length) : null,
      pairing: pair && (!conn || pair.id > conn.id) && pair.id === last ? pair.message.slice(PAIR.length) : null,
      connected: conn && conn.id > last ? conn.message.replace(CONNECTED, "").trim() : null,
    };
  }, [logs]);

  useEffect(() => {
    if (!wa.qr) {
      setQrImg(null);
      return;
    }
    QRCode.toDataURL(wa.qr, { margin: 1, width: 260 }).then(setQrImg).catch(() => setQrImg(null));
  }, [wa.qr]);

  async function sendLine(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    setInputErr(null);
    const r = await fetch(`/api/servers/${serverId}/console`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setInputErr(d.error || "Failed");
    else setInput("");
  }

  function downloadLogs() {
    const blob = new Blob(
      [logs.map((l) => `[${l.createdAt}] [${l.level}] [${l.source}] ${l.message}`).join("\n")],
      { type: "text/plain" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `server-${serverId}-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      {(qrImg || wa.pairing || wa.connected) && (
        <Card>
          {wa.connected ? (
            <div className="flex items-center gap-2 text-emerald-300 text-sm">
              <CheckCircle2 size={16} /> WhatsApp linked — {wa.connected}
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row gap-5 items-center">
              {qrImg && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrImg} alt="WhatsApp QR code" className="w-56 h-56 rounded-lg bg-white p-2" />
              )}
              {wa.pairing && (
                <div className="font-mono text-3xl tracking-[0.3em] text-indigo-200 bg-[color:var(--card-2)] border border-[color:var(--border)] rounded-xl px-5 py-4">
                  {wa.pairing}
                </div>
              )}
              <div className="text-sm space-y-1.5">
                <div className="font-semibold flex items-center gap-2">
                  <Smartphone size={16} /> Link your WhatsApp
                </div>
                <ol className="list-decimal list-inside text-[color:var(--muted)] space-y-1">
                  <li>Open WhatsApp on your phone</li>
                  <li>Settings → Linked devices → Link a device</li>
                  <li>{qrImg ? "Scan this QR code (it refreshes automatically)" : "Choose “Link with phone number” and enter this code"}</li>
                </ol>
              </div>
            </div>
          )}
        </Card>
      )}

      <Card padding="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-[color:var(--border)]">
          <div className="text-sm font-medium flex items-center gap-2">
            <span className={`status-dot ${paused ? "bg-yellow-400" : "bg-emerald-400 pulse-dot"}`} />
            Live console
          </div>
          <div className="flex flex-wrap gap-1 items-center">
            <Button size="sm" variant="ghost" onClick={() => setPaused((p) => !p)}>
              {paused ? <Play size={14} /> : <Pause size={14} />}
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setLogs([])}>
              <Trash size={14} /> Clear
            </Button>
            <Button size="sm" variant="ghost" onClick={downloadLogs}>
              <Download size={14} /> Download
            </Button>
            <label className="flex items-center gap-1.5 text-xs text-[color:var(--muted)] ps-2">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              Auto scroll
            </label>
          </div>
        </div>
        <div ref={boxRef} className="console !rounded-none !border-0 p-4 h-[460px] overflow-y-auto scrollbar" dir="ltr">
          {logs.length === 0 ? (
            <div className="text-[color:var(--muted)] text-sm">Waiting for logs...</div>
          ) : (
            logs.map((l) => (
              <div key={l.id} className="whitespace-pre-wrap break-words">
                <span className="text-slate-500">[{new Date(l.createdAt).toLocaleTimeString()}]</span>{" "}
                <span
                  className={
                    l.level === "ERROR"
                      ? "text-red-400"
                      : l.level === "WARNING"
                      ? "text-yellow-300"
                      : l.source === "install" || l.source === "build"
                      ? "text-sky-400"
                      : "text-slate-500"
                  }
                >
                  [{l.source}]
                </span>{" "}
                <span className={l.level === "ERROR" ? "text-red-300" : ""}>
                  {l.message.startsWith(QR)
                    ? "▣ WhatsApp QR code updated (see panel above)"
                    : l.message.startsWith(PAIR)
                    ? "▣ WhatsApp pairing code generated (see panel above)"
                    : l.message.replace(CONNECTED, "✓")}
                </span>
              </div>
            ))
          )}
        </div>
        <form onSubmit={sendLine} className="flex gap-2 p-3 border-t border-[color:var(--border)]">
          <Input
            dir="ltr"
            className="font-mono text-sm"
            placeholder="Send input to the process (stdin)…"
            value={input}
            maxLength={2000}
            onChange={(e) => setInput(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={!input.trim()}>
            <Send size={14} />
          </Button>
        </form>
        {inputErr && <div className="text-xs text-red-400 px-4 pb-3">{inputErr}</div>}
      </Card>
    </div>
  );
}
