"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Folder,
  File as FileIcon,
  ChevronRight,
  Upload,
  Plus,
  Trash2,
  FileArchive,
  FolderPlus,
  Save,
  Pencil,
} from "lucide-react";
import {
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  useToast,
} from "@/components/ui";
import { formatBytes, timeAgo } from "@/lib/utils";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

type Entry = {
  path: string;
  name: string;
  isDirectory: boolean;
  sizeBytes: number;
  mimeType: string | null;
  isBinary: boolean;
  updatedAt: string;
};

export default function FilesTab({ serverId }: { serverId: string }) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [editing, setEditing] = useState<{ path: string; content: string } | null>(null);
  const [originalContent, setOriginalContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState<"file" | "folder" | null>(null);
  const [newName, setNewName] = useState("");
  const [renameOpen, setRenameOpen] = useState<Entry | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    const r = await fetch(
      `/api/servers/${serverId}/files?path=${encodeURIComponent(path)}`
    );
    const d = await r.json();
    if (!r.ok) {
      toast.show(d.error || "Failed to load", "error");
      return;
    }
    setEntries(d.entries ?? []);
  }, [serverId, path]); // eslint-disable-line

  useEffect(() => {
    load();
  }, [load]);

  async function openFile(e: Entry) {
    if (e.isDirectory) {
      setPath(e.path);
      return;
    }
    const r = await fetch(
      `/api/servers/${serverId}/files/content?path=${encodeURIComponent(e.path)}`
    );
    const d = await r.json();
    if (!r.ok) return toast.show(d.error || "Failed", "error");
    if (d.isBinary) return toast.show("Binary file; cannot edit in browser", "info");
    setEditing({ path: d.path, content: d.content ?? "" });
    setOriginalContent(d.content ?? "");
  }

  async function saveFile() {
    if (!editing) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/servers/${serverId}/files/content`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editing),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed");
      setOriginalContent(editing.content);
      toast.show("Saved", "success");
      load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function uploadFiles(fileList: FileList) {
    setUploading(true);
    const fd = new FormData();
    fd.append("path", path);
    for (const f of Array.from(fileList)) fd.append("file", f);
    try {
      const r = await fetch(`/api/servers/${serverId}/files/upload`, {
        method: "POST",
        body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Upload failed");
      toast.show(`Uploaded ${d.written} entries`, "success");
      load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setUploading(false);
    }
  }

  async function createNew() {
    if (!newName.trim()) return;
    const target = path ? `${path}/${newName.trim()}` : newName.trim();
    try {
      const r = await fetch(`/api/servers/${serverId}/files`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: target,
          isDirectory: newFileOpen === "folder",
          content: newFileOpen === "file" ? "" : undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed");
      setNewFileOpen(null);
      setNewName("");
      toast.show("Created", "success");
      load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    }
  }

  async function remove(e: Entry) {
    if (!confirm(`Delete ${e.name}${e.isDirectory ? " and everything inside?" : "?"}`))
      return;
    const r = await fetch(`/api/servers/${serverId}/files`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: [e.path] }),
    });
    const d = await r.json();
    if (!r.ok) return toast.show(d.error || "Failed", "error");
    toast.show("Deleted", "success");
    load();
  }

  async function doRename() {
    if (!renameOpen) return;
    const newPath = (path ? path + "/" : "") + renameTo.trim();
    const r = await fetch(`/api/servers/${serverId}/files/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: renameOpen.path, to: newPath }),
    });
    const d = await r.json();
    if (!r.ok) return toast.show(d.error || "Failed", "error");
    setRenameOpen(null);
    setRenameTo("");
    toast.show("Renamed", "success");
    load();
  }

  const crumbs = path ? path.split("/") : [];
  const dirty = editing && editing.content !== originalContent;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5">
      <Card padding="p-0">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-[color:var(--border)] gap-1">
          <div className="text-xs text-[color:var(--muted)] overflow-hidden">
            <button className="hover:text-indigo-300" onClick={() => setPath("")}>
              /
            </button>
            {crumbs.map((c, i) => (
              <span key={i}>
                <ChevronRight size={10} className="inline" />
                <button
                  className="hover:text-indigo-300"
                  onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}
                >
                  {c}
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-1">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => inputRef.current?.click()}
              title="Upload"
            >
              <Upload size={14} />
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setNewFileOpen("file")}
              title="New file"
            >
              <Plus size={14} />
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setNewFileOpen("folder")}
              title="New folder"
            >
              <FolderPlus size={14} />
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && uploadFiles(e.target.files)}
            />
          </div>
        </div>

        {uploading && (
          <div className="text-xs text-[color:var(--muted)] px-3 py-2 border-b border-[color:var(--border)] bg-indigo-500/5">
            Uploading... (ZIP files are auto-extracted)
          </div>
        )}

        <div className="max-h-[520px] overflow-y-auto scrollbar">
          {!entries ? (
            <div className="skeleton h-32 m-3" />
          ) : entries.length === 0 ? (
            <EmptyState
              icon={<FileArchive size={20} />}
              title="Empty folder"
              description="Upload files or create new ones"
            />
          ) : (
            <ul className="divide-y divide-[color:var(--border)]">
              {entries.map((e) => (
                <li
                  key={e.path}
                  className="flex items-center justify-between px-3 py-2 hover:bg-white/5 transition group"
                >
                  <button
                    className="flex items-center gap-2 text-sm min-w-0 flex-1 text-left"
                    onClick={() => openFile(e)}
                  >
                    {e.isDirectory ? (
                      <Folder size={14} className="text-indigo-300 shrink-0" />
                    ) : (
                      <FileIcon size={14} className="text-[color:var(--muted)] shrink-0" />
                    )}
                    <span className="truncate">{e.name}</span>
                    {!e.isDirectory && (
                      <span className="text-xs text-[color:var(--muted)] ml-auto">
                        {formatBytes(e.sizeBytes)}
                      </span>
                    )}
                  </button>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition">
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setRenameOpen(e);
                        setRenameTo(e.name);
                      }}
                      title="Rename"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="btn btn-ghost btn-sm text-red-400"
                      onClick={() => remove(e)}
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* Editor */}
      <Card padding="p-0">
        {editing ? (
          <>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[color:var(--border)]">
              <div className="font-mono text-sm truncate">
                {editing.path}
                {dirty && (
                  <span className="ml-2 text-xs text-yellow-400">
                    (unsaved)
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                  Close
                </Button>
                <Button size="sm" onClick={saveFile} loading={saving}>
                  <Save size={14} /> Save
                </Button>
              </div>
            </div>
            <div className="h-[520px]">
              <MonacoEditor
                height="100%"
                theme="vs-dark"
                defaultLanguage={guessLang(editing.path)}
                value={editing.content}
                onChange={(v) => setEditing({ ...editing, content: v ?? "" })}
                options={{
                  fontSize: 13,
                  minimap: { enabled: false },
                  automaticLayout: true,
                  tabSize: 2,
                  wordWrap: "on",
                }}
                beforeMount={(monaco) => {
                  // ensure dark theme
                  monaco.editor.defineTheme("ah", {
                    base: "vs-dark",
                    inherit: true,
                    rules: [],
                    colors: { "editor.background": "#06070b" },
                  });
                }}
                onMount={(_, m) => m.editor.setTheme("ah")}
              />
            </div>
          </>
        ) : (
          <EmptyState
            icon={<FileIcon size={22} />}
            title="Pick a file to edit"
            description="Click a file in the list to open it in the editor."
          />
        )}
      </Card>

      <Modal
        open={newFileOpen !== null}
        onClose={() => {
          setNewFileOpen(null);
          setNewName("");
        }}
        title={newFileOpen === "folder" ? "New folder" : "New file"}
      >
        <Input
          autoFocus
          placeholder={newFileOpen === "folder" ? "src" : "index.js"}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="secondary" onClick={() => setNewFileOpen(null)}>
            Cancel
          </Button>
          <Button onClick={createNew}>Create</Button>
        </div>
      </Modal>

      <Modal
        open={renameOpen !== null}
        onClose={() => setRenameOpen(null)}
        title="Rename"
      >
        <Input
          autoFocus
          value={renameTo}
          onChange={(e) => setRenameTo(e.target.value)}
        />
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="secondary" onClick={() => setRenameOpen(null)}>
            Cancel
          </Button>
          <Button onClick={doRename}>Rename</Button>
        </div>
      </Modal>

      {toast.element}
    </div>
  );
}

function guessLang(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    php: "php",
    html: "html",
    css: "css",
    json: "json",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    sh: "shell",
    sql: "sql",
    go: "go",
    rs: "rust",
    rb: "ruby",
    java: "java",
    xml: "xml",
  };
  return map[ext] ?? "plaintext";
}
