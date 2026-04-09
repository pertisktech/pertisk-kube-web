import { useEffect, useMemo, useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Card } from '../components/Card';
import {
  useDashboard,
  useNodes,
  usePods,
} from '../hooks/useKubernetes';
import { useRealtimePods } from '../hooks/useRealtimePods';
import { NodeMetricGraphs } from '../components/NodeMetricGraphs';
import {
  AlertCircle,
  AlertTriangle,
  Box,
  CheckCircle,
  Cpu,
  HardDrive,
  Layers,
  Loader,
  Monitor,
  Network,
  Server,
} from '../components/Icons';
import { formatCpuRange, parseCpuToCores, parseK8sMemoryToGB } from '../utils';
import type { Pod } from '../types';

const PIE_DEFAULT = 'var(--color-muted)';
const PIE_USAGE = '#0f766e';
const PIE_REQUESTS = '#14b8a6';
const PIE_LIMITS = '#5eead4';

const parsePods = (podsStr?: string): number => {
  if (!podsStr) return 0;
  const n = parseInt(podsStr, 10);
  return Number.isNaN(n) ? 0 : n;
};

const formatCpu = (cores: number): string => {
  if (cores === 0) return '0';
  return cores % 1 === 0 ? cores.toString() : cores.toFixed(2);
};

const formatMemoryGb = (gb: number): string => {
  if (gb === 0) return '0 GB';
  return gb % 1 === 0 ? `${gb} GB` : `${gb.toFixed(2)} GB`;
};

const formatMemoryGiB = (gb: number): string => `${gb.toFixed(1)}GiB`;

const toPercent = (value?: number) => {
  if (value == null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
};

const resolveNodeMemoryUsedGb = (node: { memory_used?: string; memory?: string; memory_usage_percent?: number }) => {
  const directUsedGb = parseK8sMemoryToGB(node.memory_used);
  if (directUsedGb > 0) return directUsedGb;

  const totalGb = parseK8sMemoryToGB(node.memory);
  const usagePercent = toPercent(node.memory_usage_percent);
  if (totalGb > 0 && usagePercent > 0) return (totalGb * usagePercent) / 100;

  return 0;
};

const readResourceValue = (resourceText: string | undefined, key: 'cpu' | 'memory') => {
  if (!resourceText || resourceText === '-') return undefined;
  const pattern = new RegExp(`${key}\\s*:\\s*([^,\\s]+)`, 'i');
  const match = resourceText.match(pattern);
  return match?.[1];
};

const summarizeCounts = (items: string[]) => {
  const counts = new Map<string, number>();
  items.forEach((item) => {
    const key = item && item.trim() ? item.trim() : 'Unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

const formatRuntime = (runtime?: string) => {
  if (!runtime) return 'Unknown';
  const normalized = runtime.trim();
  return normalized || 'Unknown';
};

export const ClusterPage = () => {
  const [activeNodeRoleTab, setActiveNodeRoleTab] = useState<'master' | 'worker'>('master');
  const { data: dashboard, isLoading: dashboardLoading, error: dashboardError } = useDashboard();
  const { data: nodes, isLoading: nodesLoading, error: nodesError } = useNodes({ refetchInterval: 30_000 });
  const { data: pods, isLoading: podsLoading } = usePods();
  const { data: realtimePods = [] } = useRealtimePods<Pod>();

  const isLoading = dashboardLoading || nodesLoading || podsLoading;
  const errorMessage = (dashboardError as Error | undefined)?.message || (nodesError as Error | undefined)?.message || null;

  const readyNodeCount = useMemo(() => {
    return (nodes || []).filter((node) => {
      if (typeof node.ready === 'boolean') return node.ready;
      return String(node.ready).toLowerCase() === 'true';
    }).length;
  }, [nodes]);

  const kubeletVersions = useMemo(() => summarizeCounts((nodes || []).map((node) => node.kubelet_version || 'Unknown')), [nodes]);
  const containerRuntimes = useMemo(() => summarizeCounts((nodes || []).map((node) => formatRuntime(node.runtime))), [nodes]);
  const roleSummary = useMemo(() => summarizeCounts((nodes || []).flatMap((node) => node.roles?.length ? node.roles : ['Unassigned'])), [nodes]);

  const roleTabCounts = useMemo(() => {
    const source = nodes || [];
    const hasRole = (nodeRoles: string[] | undefined, role: 'master' | 'worker') => {
      return (nodeRoles || []).some((item) => {
        const normalized = item.toLowerCase();
        if (role === 'master') return normalized === 'master' || normalized === 'control-plane';
        return normalized === 'worker';
      });
    };

    return {
      master: source.filter((node) => hasRole(node.roles, 'master')).length,
      worker: source.filter((node) => hasRole(node.roles, 'worker')).length,
    };
  }, [nodes]);

  useEffect(() => {
    if (activeNodeRoleTab === 'master' && roleTabCounts.master === 0 && roleTabCounts.worker > 0) {
      setActiveNodeRoleTab('worker');
    }
    if (activeNodeRoleTab === 'worker' && roleTabCounts.worker === 0 && roleTabCounts.master > 0) {
      setActiveNodeRoleTab('master');
    }
  }, [activeNodeRoleTab, roleTabCounts]);

  const roleTabNodes = useMemo(() => {
    const filtered = (nodes || []).filter((node) => {
      return (node.roles || []).some((role) => {
        const normalized = role.toLowerCase();
        if (activeNodeRoleTab === 'master') return normalized === 'master' || normalized === 'control-plane';
        return normalized === 'worker';
      });
    });

    return filtered.sort((a, b) => a.name.localeCompare(b.name));
  }, [nodes, activeNodeRoleTab]);

  const roleTabMetrics = useMemo(() => {
    const totals = roleTabNodes.reduce(
      (acc, node) => {
        const nodeReady = typeof node.ready === 'boolean' ? node.ready : String(node.ready).toLowerCase() === 'true';
        const cpuAlloc = parseCpuToCores(node.cpu);
        const cpuUsed = parseCpuToCores(node.cpu_used);
        const memoryAlloc = parseK8sMemoryToGB(node.memory);
        const memoryUsed = resolveNodeMemoryUsedGb(node);

        return {
          count: acc.count + 1,
          readyCount: acc.readyCount + (nodeReady ? 1 : 0),
          cpuAlloc: acc.cpuAlloc + cpuAlloc,
          cpuUsed: acc.cpuUsed + cpuUsed,
          memoryAlloc: acc.memoryAlloc + memoryAlloc,
          memoryUsed: acc.memoryUsed + memoryUsed,
        };
      },
      {
        count: 0,
        readyCount: 0,
        cpuAlloc: 0,
        cpuUsed: 0,
        memoryAlloc: 0,
        memoryUsed: 0,
      }
    );

    return {
      ...totals,
      cpuLabel: formatCpuRange(String(totals.cpuUsed), String(totals.cpuAlloc)),
      memoryLabel: `${totals.memoryUsed.toFixed(2)} GB / ${totals.memoryAlloc.toFixed(2)} GB`,
    };
  }, [roleTabNodes]);

  const roleTabPods = useMemo(() => {
    const nodeNames = new Set(roleTabNodes.map((node) => node.name));
    return (pods || []).filter((pod) => pod.node && nodeNames.has(pod.node));
  }, [pods, roleTabNodes]);

  const roleTabRealtimePods = useMemo(() => {
    const nodeNames = new Set(roleTabNodes.map((node) => node.name));
    return realtimePods.filter((pod) => pod.node && nodeNames.has(pod.node));
  }, [realtimePods, roleTabNodes]);

  const roleTabCapacitySummary = useMemo(() => {
    let totalCPU = 0;
    let totalMemory = 0;
    let totalPodsAllocatable = 0;
    let usedCPU = 0;
    let usedMemory = 0;

    roleTabNodes.forEach((node) => {
      totalCPU += parseCpuToCores(node.cpu);
      totalMemory += parseK8sMemoryToGB(node.memory);
      totalPodsAllocatable += parsePods(node.pods);
      usedCPU += parseCpuToCores(node.cpu_used);
      usedMemory += resolveNodeMemoryUsedGb(node);
    });

    let cpuRequests = 0;
    let cpuLimits = 0;
    let memoryRequests = 0;
    let memoryLimits = 0;

    roleTabRealtimePods.forEach((pod) => {
      (pod.containers || []).forEach((container) => {
        const cpuRequestRaw = readResourceValue(container.requests, 'cpu');
        const cpuLimitRaw = readResourceValue(container.limits, 'cpu');
        const memoryRequestRaw = readResourceValue(container.requests, 'memory');
        const memoryLimitRaw = readResourceValue(container.limits, 'memory');

        cpuRequests += parseCpuToCores(cpuRequestRaw);
        cpuLimits += parseCpuToCores(cpuLimitRaw);
        memoryRequests += parseK8sMemoryToGB(memoryRequestRaw);
        memoryLimits += parseK8sMemoryToGB(memoryLimitRaw);
      });
    });

    const podCount = roleTabPods.length;

    return {
      totalCPU,
      totalMemory,
      totalPodsAllocatable,
      usedCPU,
      usedMemory,
      cpuRequests,
      cpuLimits,
      memoryRequests,
      memoryLimits,
      podCount,
    };
  }, [roleTabNodes, roleTabRealtimePods, roleTabPods]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="flex flex-col items-center gap-2">
          <Loader size={32} className="text-primary animate-spin" />
          <p className="text-text-secondary">Loading cluster overview...</p>
        </div>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-text">Cluster <span className="text-base font-normal text-text-secondary">(Cluster-wide overview and entry points)</span></h1>
        </div>
        <Card title="Unable to load cluster overview">
          <p className="text-sm text-text-secondary">{errorMessage}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Cluster <span className="text-base font-normal text-text-secondary">(Cluster-wide overview, kubelet status, and network surface)</span></h1>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* ── Cluster Info ── */}
        <Card title="Cluster Info">
          <div className="flex flex-col gap-4 text-sm">

            {/* Identity block */}
            <div className="flex items-start gap-3 rounded-xl border border-border bg-bg px-4 py-3">
              <div className="flex-shrink-0 rounded-lg bg-primary/10 p-2">
                <Server size={20} className="text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-text text-base leading-tight truncate">
                  {dashboard?.cluster_name || 'kubernetes-cluster'}
                </p>
                <span className="inline-flex items-center gap-1 mt-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-mono text-text-secondary">
                  <Layers size={10} className="text-primary" />
                  {dashboard?.kube_version || 'Unknown'}
                </span>
              </div>
            </div>

            {/* API Endpoint */}
            <div className="rounded-xl border border-border bg-bg px-4 py-3">
              <p className="text-[11px] text-text-secondary uppercase tracking-wide mb-1.5">API Endpoint</p>
              <p className="font-mono text-xs text-text break-all leading-relaxed">
                {dashboard?.api_endpoint || 'Unknown'}
              </p>
            </div>

            {/* Stat tiles */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="flex flex-col items-center rounded-xl border border-border bg-bg px-3 py-3 gap-1">
                <Monitor size={16} className="text-primary mb-0.5" />
                <p className="text-xl font-bold text-text leading-none">{nodes?.length ?? 0}</p>
                <p className="text-[11px] text-text-secondary">Nodes</p>
              </div>
              <div className="flex flex-col items-center rounded-xl border border-border bg-bg px-3 py-3 gap-1">
                <Layers size={16} className="text-[var(--color-dashboard-metric-secondary)] mb-0.5" />
                <p className="text-xl font-bold text-text leading-none">{dashboard?.namespaces ?? 0}</p>
                <p className="text-[11px] text-text-secondary">Namespaces</p>
              </div>
              <div className="flex flex-col items-center rounded-xl border border-border bg-bg px-3 py-3 gap-1">
                <Box size={16} className="text-[var(--color-dashboard-metric-tertiary)] mb-0.5" />
                <p className="text-xl font-bold text-text leading-none">{dashboard?.pods ?? 0}</p>
                <p className="text-[11px] text-text-secondary">Pods</p>
              </div>
              <div className="flex flex-col items-center rounded-xl border border-border bg-bg px-3 py-3 gap-1">
                <AlertTriangle size={16} className="text-[var(--color-icon-warning)] mb-0.5" />
                <p className="text-xl font-bold text-text leading-none">{dashboard?.events ?? 0}</p>
                <p className="text-[11px] text-text-secondary">Events</p>
              </div>
            </div>

          </div>
        </Card>

        {/* ── Kubelet & Runtime ── */}
        <Card title="Kubelet & Runtime">
          <div className="flex flex-col gap-4 text-sm">

            {/* Node readiness — progress bar */}
            {(() => {
              const total = nodes?.length ?? 0;
              const pct = total > 0 ? Math.round((readyNodeCount / total) * 100) : 0;
              const allReady = readyNodeCount === total && total > 0;
              return (
                <div className="rounded-xl border border-border bg-bg px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {allReady
                        ? <CheckCircle size={15} className="text-[var(--color-status-ready)]" />
                        : <AlertCircle size={15} className="text-[var(--color-icon-warning)]" />
                      }
                      <span className="text-[11px] text-text-secondary uppercase tracking-wide">Node Readiness</span>
                    </div>
                    <span className="font-semibold text-text text-xs">
                      {readyNodeCount} / {total} ready
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-border overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${pct}%`,
                        background: allReady ? 'var(--color-status-ready)' : 'var(--color-icon-warning)',
                      }}
                    />
                  </div>
                  <p className="mt-1.5 text-right text-[11px] text-text-secondary">{pct}%</p>
                </div>
              );
            })()}

            {/* Kubelet versions + Container runtime side by side */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Cpu size={13} className="text-primary" />
                  <p className="text-[11px] text-text-secondary uppercase tracking-wide">Kubelet</p>
                </div>
                <div className="space-y-1.5">
                  {kubeletVersions.slice(0, 4).map(([version, count]) => (
                    <div key={version} className="flex items-center justify-between rounded-lg border border-border bg-bg px-3 py-2">
                      <span className="font-mono text-[11px] text-text truncate pr-2">{version}</span>
                      <span className="shrink-0 rounded-full bg-primary/10 text-primary text-[10px] font-semibold px-1.5 py-0.5 leading-none">
                        {count}n
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Network size={13} className="text-[var(--color-dashboard-metric-secondary)]" />
                  <p className="text-[11px] text-text-secondary uppercase tracking-wide">Runtime</p>
                </div>
                <div className="space-y-1.5">
                  {containerRuntimes.slice(0, 4).map(([runtime, count]) => (
                    <div key={runtime} className="flex items-center justify-between rounded-lg border border-border bg-bg px-3 py-2">
                      <span className="font-mono text-[11px] text-text truncate pr-2">{runtime}</span>
                      <span className="shrink-0 rounded-full bg-[var(--color-dashboard-metric-secondary)]/10 text-[var(--color-dashboard-metric-secondary)] text-[10px] font-semibold px-1.5 py-0.5 leading-none">
                        {count}n
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Role badges */}
            <div>
              <p className="text-[11px] text-text-secondary uppercase tracking-wide mb-2">Node Roles</p>
              <div className="flex flex-wrap gap-2">
                {roleSummary.map(([role, count]) => (
                  <span
                    key={role}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-bg px-3 py-1 text-xs text-text"
                  >
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full"
                      style={{
                        background: role === 'control-plane' || role === 'master'
                          ? 'var(--color-primary)'
                          : role === 'worker'
                            ? 'var(--color-dashboard-metric-secondary)'
                            : 'var(--color-text-secondary)',
                      }}
                    />
                    {role}
                    <span className="text-text-secondary ml-0.5">×{count}</span>
                  </span>
                ))}
              </div>
            </div>

          </div>
        </Card>
      </div>

      <Card title="Metrics">
        <div className="space-y-4 text-sm">
          <div className="border-b border-border pb-2">
            <div className="inline-flex rounded-lg border border-border bg-bg p-0.5" role="tablist" aria-label="Node role tabs">
              {(['master', 'worker'] as const).map((role) => {
                const isActive = activeNodeRoleTab === role;
                const count = roleTabCounts[role];
                return (
                  <button
                    key={role}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setActiveNodeRoleTab(role)}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                      isActive
                        ? 'bg-primary text-white'
                        : 'text-text-secondary hover:text-text hover:bg-hover'
                    }`}
                  >
                    {role === 'master' ? 'Master' : 'Worker'} ({count})
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="rounded-lg border border-border bg-bg p-4">
              <p className="text-xs text-text-secondary mb-3">Master / Worker Metrics</p>
              {roleTabMetrics.count === 0 ? (
                <div className="rounded-lg border border-border bg-bg px-3 py-3 text-xs text-text-secondary">
                  No {activeNodeRoleTab} nodes found.
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="text-xs text-text-secondary">
                    {roleTabMetrics.readyCount}/{roleTabMetrics.count} ready
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="rounded-lg border border-border bg-bg px-3 py-3">
                      <p className="text-xs text-text-secondary mb-1">CPU (group total)</p>
                      <p className="text-sm font-medium text-text">{roleTabMetrics.cpuLabel}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-bg px-3 py-3">
                      <p className="text-xs text-text-secondary mb-1">Memory (group total)</p>
                      <p className="text-sm font-medium text-text">{roleTabMetrics.memoryLabel}</p>
                    </div>
                  </div>

                  <div className="pt-1 border-t border-border">
                    <NodeMetricGraphs nodes={roleTabNodes} pods={roleTabPods} />
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border bg-bg p-4">
              <p className="text-xs text-text-secondary mb-3">Resource Summary (CPU / Memory / Pods)</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="rounded-xl border border-border bg-bg p-3 flex flex-col items-center chart-theme-text">
                  <div className="flex items-center gap-2 mb-2">
                    <Cpu size={16} className="text-dashboard-metric-primary" />
                    <span className="font-semibold text-text text-sm">CPU</span>
                  </div>
                  <div className="w-full h-36 min-h-[144px]">
                    <ResponsiveContainer width="100%" height={144} minHeight={144}>
                      <PieChart>
                        <Pie
                          data={[
                            { name: 'Usage', value: Math.max(0, roleTabCapacitySummary.usedCPU) || 0.01, color: PIE_USAGE },
                            {
                              name: 'Available',
                              value: Math.max(0, roleTabCapacitySummary.totalCPU - roleTabCapacitySummary.usedCPU) || (roleTabCapacitySummary.totalCPU || 0.01),
                              color: PIE_DEFAULT,
                            },
                          ]}
                          cx="50%"
                          cy="50%"
                          innerRadius={38}
                          outerRadius={52}
                          dataKey="value"
                        >
                          {[{ color: PIE_USAGE }, { color: PIE_DEFAULT }].map((entry, index) => (
                            <Cell key={index} fill={entry.color} />
                          ))}
                        </Pie>
                        <Pie
                          data={[
                            { name: 'Requests', value: Math.max(0, roleTabCapacitySummary.cpuRequests) || 0.01, color: PIE_REQUESTS },
                            {
                              name: 'Available',
                              value: Math.max(0, roleTabCapacitySummary.totalCPU - roleTabCapacitySummary.cpuRequests) || (roleTabCapacitySummary.totalCPU || 0.01),
                              color: PIE_DEFAULT,
                            },
                          ]}
                          cx="50%"
                          cy="50%"
                          innerRadius={25}
                          outerRadius={37}
                          dataKey="value"
                        >
                          {[{ color: PIE_REQUESTS }, { color: PIE_DEFAULT }].map((entry, index) => (
                            <Cell key={`req-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Pie
                          data={[
                            { name: 'Limits', value: Math.max(0, roleTabCapacitySummary.cpuLimits) || 0.01, color: PIE_LIMITS },
                            {
                              name: 'Available',
                              value: Math.max(0, roleTabCapacitySummary.totalCPU - roleTabCapacitySummary.cpuLimits) || (roleTabCapacitySummary.totalCPU || 0.01),
                              color: PIE_DEFAULT,
                            },
                          ]}
                          cx="50%"
                          cy="50%"
                          innerRadius={12}
                          outerRadius={24}
                          dataKey="value"
                        >
                          {[{ color: PIE_LIMITS }, { color: PIE_DEFAULT }].map((entry, index) => (
                            <Cell key={`lim-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'var(--color-surface)',
                            color: 'var(--color-text)',
                            borderRadius: '8px',
                            padding: '10px 12px',
                            border: '1px solid var(--color-border)',
                          }}
                          formatter={(value, name) => [`${formatCpu(Number(value ?? 0))} cores`, String(name ?? '')]}
                          labelFormatter={() => 'CPU'}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="w-full mt-1 space-y-0.5 text-[11px] text-text-secondary">
                    <p>Usage: {roleTabCapacitySummary.usedCPU.toFixed(2)}</p>
                    <p>Requests: {roleTabCapacitySummary.cpuRequests.toFixed(2)}</p>
                    <p>Limits: {roleTabCapacitySummary.cpuLimits.toFixed(2)}</p>
                    <p>Allocatable Capacity: {roleTabCapacitySummary.totalCPU.toFixed(2)}</p>
                    <p>Capacity: {roleTabCapacitySummary.totalCPU.toFixed(2)}</p>
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-bg p-3 flex flex-col items-center chart-theme-text">
                  <div className="flex items-center gap-2 mb-2">
                    <HardDrive size={16} className="text-dashboard-metric-secondary" />
                    <span className="font-semibold text-text text-sm">Memory</span>
                  </div>
                  <div className="w-full h-36 min-h-[144px]">
                    <ResponsiveContainer width="100%" height={144} minHeight={144}>
                      <PieChart>
                        <Pie
                          data={[
                            { name: 'Usage', value: Math.max(0, roleTabCapacitySummary.usedMemory) || 0.01, color: PIE_USAGE },
                            {
                              name: 'Available',
                              value: Math.max(0, roleTabCapacitySummary.totalMemory - roleTabCapacitySummary.usedMemory) || (roleTabCapacitySummary.totalMemory || 0.01),
                              color: PIE_DEFAULT,
                            },
                          ]}
                          cx="50%"
                          cy="50%"
                          innerRadius={38}
                          outerRadius={52}
                          dataKey="value"
                        >
                          {[{ color: PIE_USAGE }, { color: PIE_DEFAULT }].map((entry, index) => (
                            <Cell key={index} fill={entry.color} />
                          ))}
                        </Pie>
                        <Pie
                          data={[
                            { name: 'Requests', value: Math.max(0, roleTabCapacitySummary.memoryRequests) || 0.01, color: PIE_REQUESTS },
                            {
                              name: 'Available',
                              value: Math.max(0, roleTabCapacitySummary.totalMemory - roleTabCapacitySummary.memoryRequests) || (roleTabCapacitySummary.totalMemory || 0.01),
                              color: PIE_DEFAULT,
                            },
                          ]}
                          cx="50%"
                          cy="50%"
                          innerRadius={25}
                          outerRadius={37}
                          dataKey="value"
                        >
                          {[{ color: PIE_REQUESTS }, { color: PIE_DEFAULT }].map((entry, index) => (
                            <Cell key={`mem-req-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Pie
                          data={[
                            { name: 'Limits', value: Math.max(0, roleTabCapacitySummary.memoryLimits) || 0.01, color: PIE_LIMITS },
                            {
                              name: 'Available',
                              value: Math.max(0, roleTabCapacitySummary.totalMemory - roleTabCapacitySummary.memoryLimits) || (roleTabCapacitySummary.totalMemory || 0.01),
                              color: PIE_DEFAULT,
                            },
                          ]}
                          cx="50%"
                          cy="50%"
                          innerRadius={12}
                          outerRadius={24}
                          dataKey="value"
                        >
                          {[{ color: PIE_LIMITS }, { color: PIE_DEFAULT }].map((entry, index) => (
                            <Cell key={`mem-lim-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'var(--color-surface)',
                            color: 'var(--color-text)',
                            borderRadius: '8px',
                            padding: '10px 12px',
                            border: '1px solid var(--color-border)',
                          }}
                          formatter={(value, name) => [formatMemoryGb(Number(value ?? 0)), String(name ?? '')]}
                          labelFormatter={() => 'Memory'}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="w-full mt-1 space-y-0.5 text-[11px] text-text-secondary">
                    <p>Usage: {formatMemoryGiB(roleTabCapacitySummary.usedMemory)}</p>
                    <p>Requests: {formatMemoryGiB(roleTabCapacitySummary.memoryRequests)}</p>
                    <p>Limits: {formatMemoryGiB(roleTabCapacitySummary.memoryLimits)}</p>
                    <p>Allocatable Capacity: {formatMemoryGiB(roleTabCapacitySummary.totalMemory)}</p>
                    <p>Capacity: {formatMemoryGiB(roleTabCapacitySummary.totalMemory)}</p>
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-bg p-3 flex flex-col items-center chart-theme-text">
                  <div className="flex items-center gap-2 mb-2">
                    <Box size={16} className="text-dashboard-metric-tertiary" />
                    <span className="font-semibold text-text text-sm">Pods</span>
                  </div>
                  <div className="w-full h-36 min-h-[144px]">
                    <ResponsiveContainer width="100%" height={144} minHeight={144}>
                      <PieChart>
                        <Pie
                          data={[
                            { name: 'Usage', value: roleTabCapacitySummary.podCount || 0.01, color: PIE_REQUESTS },
                            {
                              name: 'Available',
                              value: Math.max(0, (roleTabCapacitySummary.totalPodsAllocatable || 1) - roleTabCapacitySummary.podCount) || 0.01,
                              color: PIE_DEFAULT,
                            },
                          ]}
                          cx="50%"
                          cy="50%"
                          innerRadius={34}
                          outerRadius={52}
                          dataKey="value"
                        >
                          {[{ color: PIE_REQUESTS }, { color: PIE_DEFAULT }].map((entry, index) => (
                            <Cell key={index} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'var(--color-surface)',
                            color: 'var(--color-text)',
                            borderRadius: '8px',
                            padding: '10px 12px',
                            border: '1px solid var(--color-border)',
                          }}
                          formatter={(value, name) => [`${Math.round(Number(value ?? 0))} pods`, String(name ?? '')]}
                          labelFormatter={() => `Capacity: ${roleTabCapacitySummary.totalPodsAllocatable} pods`}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="w-full mt-1 space-y-0.5 text-[11px] text-text-secondary">
                    <p>Usage: {roleTabCapacitySummary.podCount}</p>
                    <p>Capacity: {roleTabCapacitySummary.totalPodsAllocatable || 0}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
};
