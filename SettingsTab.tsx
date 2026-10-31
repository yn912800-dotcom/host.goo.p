"use client";
import { useState } from "react";
import { Button, Card, Input, Label, Textarea, useToast } from "@/components/ui";

export default function SettingsTab({
  serverId,
  initial,
  onSaved,
}: {
  serverId: string;
  initial: {
    name: string;
    description: string | null;
    startCommand: string | null;
    installCommand: string | null;
    entryPoint: string | null;
    autoRestart: boolean;
  };
  onSaved: () => void;
}) {
  const [v, setV] = useState({ ...initial });
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  async function save() {
    setSaving(true);
    try {
      const r = await fetch(`/api/servers/${serverId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: v.name,
          description: v.description || null,
          startCommand: v.startCommand || null,
          installCommand: v.installCommand || null,
          entryPoint: v.entryPoint || null,
          autoRestart: v.autoRestart,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed");
      toast.show("Saved", "success");
      onSaved();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <h3 className="font-semibold mb-4">Project settings</h3>
      <div className="space-y-4 max-w-xl">
        <div>
          <Label>Name</Label>
          <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </div>
        <div>
          <Label>Description</Label>
          <Textarea
            value={v.description ?? ""}
            onChange={(e) => setV({ ...v, description: e.target.value })}
          />
        </div>
        <div>
          <Label>Entry point</Label>
          <Input
            value={v.entryPoint ?? ""}
            onChange={(e) => setV({ ...v, entryPoint: e.target.value })}
          />
        </div>
        <div>
          <Label>Install command</Label>
          <Input
            value={v.installCommand ?? ""}
            onChange={(e) => setV({ ...v, installCommand: e.target.value })}
          />
        </div>
        <div>
          <Label>Start command</Label>
          <Input
            value={v.startCommand ?? ""}
            onChange={(e) => setV({ ...v, startCommand: e.target.value })}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={v.autoRestart}
            onChange={(e) => setV({ ...v, autoRestart: e.target.checked })}
          />
          Auto-restart on crash (with crash-loop protection)
        </label>
        <Button onClick={save} loading={saving}>
          Save changes
        </Button>
      </div>
      {toast.element}
    </Card>
  );
}
