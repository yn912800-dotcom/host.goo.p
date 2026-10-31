"use client";
import { useEffect, useState } from "react";
import { Database, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button, Card, EmptyState, useToast } from "@/components/ui";
import { formatBytes, timeAgo } from "@/lib/utils";

type Backup = {
  id: string;
  name: string;
  sizeBytes: number;
  fileCount: number;
  status: string;
  createdAt: string;
};

export default function BackupsTab({ serverId }: { serverId: string }) {
  const [list, setList] = useState<Backup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function load() {
    const r = await fetch(`/api/servers/${serverId}/backups`);
    const d = await r.json();
    if (r.ok) setList(d.backups);
  }
  useEffect(() => {
    load();
  }, [serverId]); // eslint-disable-line

  async function create() {
    setBusy(true);
    try {
      const r = await fetch(`/api/servers/${serverId}/backups`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed");
      toast.show("Backup created", "success");
      load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  async function restore(id: string) {
    if (!confirm("Restore this backup? Current files will be replaced."))
      return;
    const r = await fetch(`/api/servers/${serverId}/backups`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "restore", backupId: id }),
    });
    const d = await r.json();
    if (!r.ok) return toast.show(d.error || "Failed", "error");
    toast.show("Restored", "success");
  }

  async function remove(id: string) {
    if (!confirm("Delete this backup?")) return;
    const r = await fetch(
      `/api/servers/${serverId}/backups?backupId=${id}`,
      { method: "DELETE" }
    );
    const d = await r.json();
    if (!r.ok) return toast.show(d.error || "Failed", "error");
    load();
  }

  return (
    <Card padding="p-0">
      <div className="flex items-center justify-between px-5 py-4 border-b border-[color:var(--border)]">
        <h3 className="font-semibold">Backups</h3>
        <Button onClick={create} loading={busy} size="sm">
          <Plus size={14} /> New backup
        </Button>
      </div>
      {!list ? (
        <div className="skeleton h-24 m-5" />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Database size={20} />}
          title="No backups yet"
          description="Create your first snapshot to be able to restore your files."
        />
      ) : (
        <ul className="divide-y divide-[color:var(--border)]">
          {list.map((b) => (
            <li key={b.id} className="flex items-center justify-between px-5 py-3">
              <div>
                <div className="font-medium">{b.name}</div>
                <div className="text-xs text-[color:var(--muted)] mt-1">
                  {b.fileCount} files · {formatBytes(b.sizeBytes)} · {timeAgo(b.createdAt)}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => restore(b.id)}>
                  <RotateCcw size={14} /> Restore
                </Button>
                <button
                  className="btn btn-ghost btn-sm text-red-400"
                  onClick={() => remove(b.id)}
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
