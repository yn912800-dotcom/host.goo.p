"use client";
import { useEffect, useState } from "react";
import { Button, Card, EmptyState, Input, useToast } from "@/components/ui";
import { Eye, EyeOff, KeySquare, Plus, Trash2 } from "lucide-react";

type EnvVar = {
  id: string;
  key: string;
  value: string;
  isSecret: boolean;
};

export default function EnvTab({ serverId }: { serverId: string }) {
  const [vars, setVars] = useState<EnvVar[] | null>(null);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [secret, setSecret] = useState(false);
  const toast = useToast();

  async function load() {
    const r = await fetch(`/api/servers/${serverId}/env`);
    const d = await r.json();
    if (r.ok) setVars(d.env);
  }
  useEffect(() => {
    load();
  }, [serverId]); // eslint-disable-line

  async function save() {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key))
      return toast.show("Invalid key (A-Z, 0-9, _)", "error");
    const r = await fetch(`/api/servers/${serverId}/env`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, value, isSecret: secret }),
    });
    const d = await r.json();
    if (!r.ok) return toast.show(d.error || "Failed", "error");
    setKey("");
    setValue("");
    setSecret(false);
    toast.show("Saved", "success");
    load();
  }

  async function remove(k: string) {
    if (!confirm(`Delete ${k}?`)) return;
    const r = await fetch(`/api/servers/${serverId}/env?key=${encodeURIComponent(k)}`, {
      method: "DELETE",
    });
    const d = await r.json();
    if (!r.ok) return toast.show(d.error || "Failed", "error");
    load();
  }

  return (
    <Card padding="p-0">
      <div className="px-5 py-4 border-b border-[color:var(--border)]">
        <h3 className="font-semibold">Environment variables</h3>
        <p className="text-xs text-[color:var(--muted)] mt-1">
          Injected into your project at runtime. Secrets are masked and never
          logged.
        </p>
      </div>
      <div className="p-5 border-b border-[color:var(--border)]">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-2">
          <Input placeholder="KEY" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} />
          <Input placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} />
          <label className="flex items-center gap-1.5 text-xs text-[color:var(--muted)] px-2">
            <input
              type="checkbox"
              checked={secret}
              onChange={(e) => setSecret(e.target.checked)}
            />
            Secret
          </label>
          <Button onClick={save}>
            <Plus size={14} /> Add
          </Button>
        </div>
      </div>
      {!vars ? (
        <div className="skeleton h-24 m-5" />
      ) : vars.length === 0 ? (
        <EmptyState
          icon={<KeySquare size={20} />}
          title="No variables yet"
          description="Add your first variable above"
        />
      ) : (
        <ul className="divide-y divide-[color:var(--border)]">
          {vars.map((v) => (
            <li key={v.id} className="flex items-center justify-between px-5 py-3 gap-3">
              <div className="min-w-0 flex-1 grid grid-cols-[auto_1fr] gap-x-3 items-center">
                <code className="text-sm font-semibold text-indigo-300">{v.key}</code>
                <code className="font-mono text-sm truncate text-[color:var(--muted)]">
                  {v.isSecret && !visible[v.id]
                    ? "••••••••••••"
                    : v.value}
                </code>
              </div>
              <div className="flex gap-1">
                {v.isSecret && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setVisible((p) => ({ ...p, [v.id]: !p[v.id] }))}
                  >
                    {visible[v.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                )}
                <button
                  className="btn btn-ghost btn-sm text-red-400"
                  onClick={() => remove(v.key)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {toast.element}
    </Card>
  );
}
