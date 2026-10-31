"use client";
import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Area,
  AreaChart,
} from "recharts";
import { Card } from "@/components/ui";
import { formatBytes } from "@/lib/utils";

type Metric = {
  id: number;
  cpuPercent: number;
  ramMb: number;
  diskMb: number;
  createdAt: string;
};

type Resp = {
  metrics: Metric[];
  limits: { ramMb: number; storageMb: number; cpuMillis: number };
  status: string;
};

export default function MetricsTab({ serverId }: { serverId: string }) {
  const [data, setData] = useState<Resp | null>(null);

  useEffect(() => {
    const load = async () => {
      const r = await fetch(`/api/servers/${serverId}/metrics?limit=30`);
      const d = await r.json();
      if (r.ok) setData(d);
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [serverId]);

  if (!data) return <div className="skeleton h-80" />;

  const chartData = data.metrics.map((m) => ({
    t: new Date(m.createdAt).toLocaleTimeString().slice(0, 5),
    cpu: m.cpuPercent,
    ram: m.ramMb,
    disk: m.diskMb,
  }));
  const latest = data.metrics[data.metrics.length - 1];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Stat
          label="CPU"
          value={`${latest?.cpuPercent ?? 0}%`}
          hint={`Limit: ${data.limits.cpuMillis / 1000} vCPU`}
        />
        <Stat
          label="Memory"
          value={formatBytes((latest?.ramMb ?? 0) * 1024 * 1024)}
          hint={`of ${formatBytes(data.limits.ramMb * 1024 * 1024)}`}
        />
        <Stat
          label="Storage"
          value={formatBytes((latest?.diskMb ?? 0) * 1024 * 1024)}
          hint={`of ${formatBytes(data.limits.storageMb * 1024 * 1024)}`}
        />
      </div>

      <Card>
        <h3 className="font-semibold text-sm mb-3">CPU usage (%)</h3>
        <div className="h-56">
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid stroke="#242838" strokeDasharray="3 3" />
              <XAxis dataKey="t" stroke="#8b93a5" fontSize={11} />
              <YAxis stroke="#8b93a5" fontSize={11} domain={[0, 100]} />
              <Tooltip
                contentStyle={{
                  background: "#11131a",
                  border: "1px solid #242838",
                  borderRadius: 8,
                }}
              />
              <Line
                type="monotone"
                dataKey="cpu"
                stroke="#6366f1"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold text-sm mb-3">RAM (MB)</h3>
        <div className="h-56">
          <ResponsiveContainer>
            <AreaChart data={chartData}>
              <CartesianGrid stroke="#242838" strokeDasharray="3 3" />
              <XAxis dataKey="t" stroke="#8b93a5" fontSize={11} />
              <YAxis stroke="#8b93a5" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: "#11131a",
                  border: "1px solid #242838",
                  borderRadius: 8,
                }}
              />
              <Area
                type="monotone"
                dataKey="ram"
                stroke="#8b5cf6"
                fill="#8b5cf640"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="text-xs text-[color:var(--muted)]">
        Real measurements of the project&apos;s process tree (CPU time & RSS from /proc),
        sampled every 10 seconds while the server is running and kept for 24 hours.
        Exceeding the RAM limit kills the process (OOM) and triggers auto-restart.
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <div className="text-xs text-[color:var(--muted)]">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {hint && (
        <div className="text-xs text-[color:var(--muted)] mt-1">{hint}</div>
      )}
    </Card>
  );
}
