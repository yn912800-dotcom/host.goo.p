"use client";
import { useEffect, useState } from "react";
import { Globe, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Badge, Button, Card, EmptyState, Input, useToast } from "@/components/ui";

type Domain = {
  id: string;
  hostname: string;
  isPrimary: boolean;
  sslEnabled: boolean;
  sslStatus: string;
  verified: boolean;
  createdAt: string;
};

export default function DomainsTab({ serverId }: { serverId: string }) {
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [host, setHost] = useState("");
  const toast = useToast();

  async function load() {
    const r = await fetch(`/api/servers/${serverId}/domains`);
    const d = await r.json();
    if (r.ok) setDomains(d.domains);
  }
  useEffect(() => {
    load();
  }, [serverId]); // eslint-disable-line

  async function add() {
    const r = await fetch(`/api/servers/${serverId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: host, sslEnabled: true }),
    });
    const d = await r.json();
    if (!r.ok) return toast.show(d.error || "Failed", "error");
    setHost("");
    toast.show("Domain added", "success");
    load();
  }

  async function remove(id: string) {
    if (!confirm("Remove this domain?")) return;
    const r = await fetch(`/api/servers/${serverId}/domains?domainId=${id}`, {
      method: "DELETE",
    });
    const d = await r.json();
    if (!r.ok) return toast.show(d.error || "Failed", "error");
    load();
  }

  return (
    <Card padding="p-0">
      <div className="px-5 py-4 border-b border-[color:var(--border)]">
        <h3 className="font-semibold">Domains</h3>
        <p className="text-xs text-[color:var(--muted)] mt-1">
          Point an A/CNAME record to the platform, then add your hostname here.
        </p>
      </div>
      <div className="p-5 border-b border-[color:var(--border)] flex gap-2">
        <Input
          placeholder="app.example.com"
          value={host}
          onChange={(e) => setHost(e.target.value)}
        />
        <Button onClick={add}>
          <Plus size={14} /> Add
        </Button>
      </div>
      {!domains ? (
        <div className="skeleton h-24 m-5" />
      ) : domains.length === 0 ? (
        <EmptyState icon={<Globe size={20} />} title="No domains yet" />
      ) : (
        <ul className="divide-y divide-[color:var(--border)]">
          {domains.map((d) => (
            <li key={d.id} className="flex items-center justify-between px-5 py-3">
              <div>
                <div className="flex items-center gap-2">
                  <Globe size={14} className="text-indigo-300" />
                  <span className="font-medium">{d.hostname}</span>
                  {d.isPrimary && <Badge variant="info">Primary</Badge>}
                </div>
                <div className="flex items-center gap-2 mt-1 text-xs text-[color:var(--muted)]">
                  <ShieldCheck size={12} />
                  SSL: {d.sslStatus}
                  <span>· {d.verified ? "Verified" : "Pending verification"}</span>
                </div>
              </div>
              <button
                className="btn btn-ghost btn-sm text-red-400"
                onClick={() => remove(d.id)}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {toast.element}
    </Card>
  );
}
