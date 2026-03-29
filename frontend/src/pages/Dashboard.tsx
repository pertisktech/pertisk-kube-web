import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { useDashboard, useNodes, usePods } from '../hooks/useKubernetes';
import { WorkloadSummary } from '../components/WorkloadSummary';
import { MetricsCharts } from '../components/MetricsCharts';
import { GaugeChart } from '../components/GaugeChart';
import {
  Box,
  Server,
  Cpu,
  HardDrive,
  TrendingUp,
  Monitor,
  CheckCircle,
  XCircle,
  AlertCircle,
  ExternalLink,
  Loader,
} from '../components/Icons';
import { formatCpuRange, formatK8sQuantityUsedAlloc, formatMemoryUsedAlloc } from '../utils';
import { K8sNode } from '../types';

const CHART_USED = '#14b8a6';
const CHART_AVAILABLE = 'var(--color-muted)';

// Helper to get IPv4 and IPv6 for display (values only, no labels)
function getNodeIPv4IPv6(node: K8sNode): { ipv4: string | null; ipv6: string | null } {
  const ips: string[] = [];
  if (node.internal_ip) ips.push(...node.internal_ip.split(',').map((s) => s.trim()).filter(Boolean));
  if (node.external_ip && node.external_ip !== node.internal_ip) {
    node.external_ip.split(',').map((s) => s.trim()).filter(Boolean).forEach((ip) => {
      if (!ips.includes(ip)) ips.push(ip);
    });
  }
  const ipv4First = ips.filter((ip) => !ip.includes(':'))[0];
  const ipv6First = ips.filter((ip) => ip.includes(':'))[0];
  return {
    ipv4: ipv4First || node.ipv4 || node.ip || null,
    ipv6: ipv6First || node.ipv6 || null,
  };
}

// Role badge colors: control-plane, master, worker (distinct from Ready status)
function getRoleBadgeStyle(role: string): { bg: string; color: string; border: string } {
  const r = role.toLowerCase();
  if (r === 'control-plane') {
    return {
      bg: 'var(--color-dashboard-metric-secondary-bg)',
      color: 'var(--color-dashboard-metric-secondary)',
      border: 'color-mix(in srgb, var(--color-dashboard-metric-secondary) 40%, transparent)',
    };
  }
  if (r === 'master') {
    return {
      bg: 'var(--color-dashboard-warning-bg)',
      color: 'var(--color-dashboard-warning)',
      border: 'color-mix(in srgb, var(--color-dashboard-warning) 40%, transparent)',
    };
  }
  if (r === 'worker') {
    return {
      bg: 'var(--color-dashboard-metric-quaternary-bg)',
      color: 'var(--color-dashboard-metric-quaternary)',
      border: 'color-mix(in srgb, var(--color-dashboard-metric-quaternary) 40%, transparent)',
    };
  }
  return {
    bg: 'var(--color-hover)',
    color: 'var(--color-text-secondary)',
    border: 'var(--color-border)',
  };
}

// Helper to parse CPU string (e.g., "4" or "4000m")
function parseCPU(cpuStr?: string): number {
  if (!cpuStr) return 0;
  if (cpuStr.endsWith('m')) {
    return parseInt(cpuStr) / 1000;
  }
  return parseFloat(cpuStr);
}

// Helper to parse Memory string (e.g., "16Gi", "16384Mi")
function parseMemory(memStr?: string): number {
  if (!memStr) return 0;
  const num = parseFloat(memStr);
  if (memStr.endsWith('Gi')) return num;
  if (memStr.endsWith('Mi')) return num / 1024;
  if (memStr.endsWith('Ki')) return num / (1024 * 1024);
  return num;
}

// Helper to format CPU display
function formatCPU(cores: number): string {
  if (cores === 0) return '0';
  return cores % 1 === 0 ? cores.toString() : cores.toFixed(2);
}

// Helper to format Memory display (unit: GB)
function formatMemory(gb: number): string {
  if (gb === 0) return '0 GB';
  return gb % 1 === 0 ? `${gb} GB` : `${gb.toFixed(2)} GB`;
}

// Helper to parse allocatable pods (integer string per node)
function parsePods(podsStr?: string): number {
  if (!podsStr) return 0;
  const n = parseInt(podsStr, 10);
  return Number.isNaN(n) ? 0 : n;
}

const usageBarWidth = (percent: number) => (percent <= 0 ? 0 : Math.max(percent, 6));
const toPercent = (value?: number) =>
  value == null || Number.isNaN(value) ? 0 : Math.max(0, Math.min(100, value));

export const Dashboard = () => {
  const { data: dashboard, isLoading: dashLoading } = useDashboard();
  const { data: nodes, isLoading: nodesLoading } = useNodes({ refetchInterval: 30_000 });
  const { data: pods, isLoading: podsLoading } = usePods();

  const isLoading = dashLoading || nodesLoading || podsLoading;

  const sortedNodes = useMemo(() => {
    const list = [...(nodes ?? [])];
    const roleOrder = (node: { roles?: string[] }) => {
      const r = (node.roles ?? []).map((s) => s.toLowerCase());
      if (r.includes('control-plane')) return 0;
      if (r.includes('master')) return 1;
      if (r.includes('worker')) return 2;
      return 3;
    };
    list.sort((a, b) => {
      const orderA = roleOrder(a);
      const orderB = roleOrder(b);
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [nodes]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="flex flex-col items-center gap-2">
          <Loader size={32} className="text-primary animate-spin" />
          <p className="text-text-secondary">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  const totalNodeCount = nodes?.length || 0;
  const readyNodeCount =
    nodes?.filter((node) => {
      if (typeof node.ready === 'boolean') return node.ready;
      return String(node.ready).toLowerCase() === 'true';
    }).length || 0;

  const failedPodCount =
    pods?.filter((pod) => {
      const state = (pod.status || pod.phase || '').toLowerCase();
      return state === 'failed' || state === 'crashloopbackoff';
    }).length || 0;

  // Calculate total allocatable and used (from metrics) for pie charts
  let totalCPU = 0;
  let totalMemory = 0;
  let totalPodsAllocatable = 0;
  let usedCPU = 0;
  let usedMemory = 0;
  if (nodes) {
    nodes.forEach((node) => {
      totalCPU += parseCPU(node.cpu);
      totalMemory += parseMemory(node.memory);
      totalPodsAllocatable += parsePods(node.pods);
      usedCPU += parseCPU(node.cpu_used);
      usedMemory += parseMemory(node.memory_used);
    });
  }
  const podCount = dashboard?.pods ?? pods?.length ?? 0;

  // Calculate health status
  const nodeHealthPercent = totalNodeCount > 0 ? (readyNodeCount / totalNodeCount) * 100 : 0;
  const podFailurePercent =
    (dashboard?.pods || 0) > 0 ? (failedPodCount / (dashboard?.pods || 1)) * 100 : 0;

  let healthStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
  if (nodeHealthPercent < 80 || podFailurePercent > 20) {
    healthStatus = 'critical';
  } else if (nodeHealthPercent < 95 || podFailurePercent > 5) {
    healthStatus = 'warning';
  }

  return (
    <div className="space-y-4">
      {/* Enhanced Cluster Overview - matching pertisk-kube style */}
      <div className="bg-surface border border-border rounded-lg p-6 backdrop-blur-sm">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Monitor size={24} className="text-dashboard-metric-primary" />
            <h2 className="text-2xl font-bold text-text">Cluster Overview</h2>
          </div>
          <div className="flex items-center gap-2">
            {healthStatus === 'healthy' ? (
              <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-dashboard-success-bg text-dashboard-success">
                <CheckCircle size={16} />
                <span className="text-sm font-medium">Healthy</span>
              </div>
            ) : healthStatus === 'warning' ? (
              <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-dashboard-warning-bg text-dashboard-warning">
                <AlertCircle size={16} />
                <span className="text-sm font-medium">Warning</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-dashboard-danger-bg text-dashboard-danger">
                <XCircle size={16} />
                <span className="text-sm font-medium">Critical</span>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          {/* Cluster Info */}
          <div className="flex items-center justify-between text-sm text-text-secondary">
            <span>
              <span className="font-medium text-text">
                {dashboard?.cluster_name || 'kubernetes-cluster'}
              </span>
              {' • '}
              <span className="text-dashboard-info" title={dashboard?.api_endpoint || ''}>
                {dashboard?.api_endpoint
                  ? dashboard.api_endpoint.length > 40
                    ? dashboard.api_endpoint.substring(0, 40) + '...'
                    : dashboard.api_endpoint
                  : 'Unknown'}
              </span>
              {' • '}
              <span className="font-medium text-text">
                {dashboard?.kube_version || 'Unknown'}
              </span>
            </span>
            <span>Updated {new Date().toLocaleTimeString()}</span>
          </div>

          {/* Cluster resource pie charts (freelens-style: CPU, Memory, Pods) */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-6">
            {/* CPU pie */}
            <div className="bg-bg border border-border rounded-xl p-4 flex flex-col items-center chart-theme-text">
              <div className="flex items-center gap-2 mb-3">
                <Cpu size={20} className="text-dashboard-metric-primary" />
                <span className="font-semibold text-text">CPU</span>
              </div>
              <div className="w-full h-44 min-h-[176px]">
                <ResponsiveContainer width="100%" height={176} minHeight={176}>
                  <PieChart>
                    <Pie
                      data={[
                        { name: 'Used', value: Math.max(0, usedCPU) || 0.01, color: CHART_USED },
                        {
                          name: 'Available',
                          value: Math.max(0, totalCPU - usedCPU) || (totalCPU || 0.01),
                          color: CHART_AVAILABLE,
                        },
                      ]}
                      cx="50%"
                      cy="50%"
                      innerRadius={44}
                      outerRadius={64}
                      paddingAngle={0}
                      dataKey="value"
                    >
                      {[{ color: CHART_USED }, { color: CHART_AVAILABLE }].map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
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
                      formatter={(value: number | undefined, name: string | undefined) => [`${formatCPU(Number(value ?? 0))} cores`, name ?? '']}
                      labelFormatter={() => `Total: ${formatCPU(totalCPU)} cores`}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-text-secondary mt-2">
                {formatCPU(usedCPU)} / {formatCPU(totalCPU)} cores
              </p>
            </div>

            {/* Memory pie */}
            <div className="bg-bg border border-border rounded-xl p-4 flex flex-col items-center chart-theme-text">
              <div className="flex items-center gap-2 mb-3">
                <HardDrive size={20} className="text-dashboard-metric-secondary" />
                <span className="font-semibold text-text">Memory</span>
              </div>
              <div className="w-full h-44 min-h-[176px]">
                <ResponsiveContainer width="100%" height={176} minHeight={176}>
                  <PieChart>
                    <Pie
                      data={[
                        { name: 'Used', value: Math.max(0, usedMemory) || 0.01, color: CHART_USED },
                        {
                          name: 'Available',
                          value: Math.max(0, totalMemory - usedMemory) || (totalMemory || 0.01),
                          color: CHART_AVAILABLE,
                        },
                      ]}
                      cx="50%"
                      cy="50%"
                      innerRadius={44}
                      outerRadius={64}
                      paddingAngle={0}
                      dataKey="value"
                    >
                      {[{ color: CHART_USED }, { color: CHART_AVAILABLE }].map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
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
                      formatter={(value: number | undefined, name: string | undefined) => [formatMemory(Number(value ?? 0)), name ?? '']}
                      labelFormatter={() => `Total: ${formatMemory(totalMemory)}`}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-text-secondary mt-2">
                {formatMemory(usedMemory)} / {formatMemory(totalMemory)}
              </p>
            </div>

            {/* Pods pie */}
            <div className="bg-bg border border-border rounded-xl p-4 flex flex-col items-center chart-theme-text">
              <div className="flex items-center gap-2 mb-3">
                <Box size={20} className="text-dashboard-metric-tertiary" />
                <span className="font-semibold text-text">Pods</span>
              </div>
              <div className="w-full h-44 min-h-[176px]">
                <ResponsiveContainer width="100%" height={176} minHeight={176}>
                  <PieChart>
                    <Pie
                      data={[
                        { name: 'Used', value: podCount || 0.01, color: CHART_USED },
                        {
                          name: 'Available',
                          value: Math.max(0, (totalPodsAllocatable || 1) - podCount) || 0.01,
                          color: CHART_AVAILABLE,
                        },
                      ]}
                      cx="50%"
                      cy="50%"
                      innerRadius={44}
                      outerRadius={64}
                      paddingAngle={0}
                      dataKey="value"
                    >
                      {[{ color: CHART_USED }, { color: CHART_AVAILABLE }].map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
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
                      formatter={(value: number | undefined, name: string | undefined) => [
                        `${Math.round(Number(value ?? 0))} pods`,
                        name ?? '',
                      ]}
                      labelFormatter={() => `Capacity: ${totalPodsAllocatable} pods`}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-text-secondary mt-2">
                {podCount} / {totalPodsAllocatable || 0} pods
              </p>
            </div>
          </div>

          {/* Nodes summary line below pies */}
          <div className="mt-4 pt-4 border-t border-border flex items-center gap-4 text-sm text-text-secondary">
            <span className="flex items-center gap-1.5">
              <Server size={14} className="text-dashboard-metric-quaternary" />
              Nodes:{' '}
              <span style={{
                color: nodeHealthPercent === 100
                  ? 'var(--color-status-ready)'
                  : nodeHealthPercent >= 80
                    ? 'var(--color-dashboard-warning)'
                    : 'var(--color-dashboard-danger)',
                fontWeight: 600,
              }}>
                {readyNodeCount}/{totalNodeCount} ready
              </span>
            </span>
            <span>
              {dashboard?.cluster_name || 'kubernetes-cluster'} • {dashboard?.kube_version || 'Unknown'}
            </span>
          </div>
        </div>
      </div>

      {/* Nodes — dashboard card grid */}
      <div className="bg-surface border border-border rounded-xl p-6 backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-5">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-[var(--color-dashboard-metric-primary-bg)]">
              <Server size={24} className="text-[var(--color-dashboard-metric-primary)]" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-text">Nodes</h2>
              <p className="text-sm font-medium" style={{
                color: nodeHealthPercent === 100
                  ? 'var(--color-status-ready)'
                  : nodeHealthPercent >= 80
                    ? 'var(--color-dashboard-warning)'
                    : 'var(--color-dashboard-danger)',
              }}>
                {readyNodeCount}/{totalNodeCount} ready
                {totalNodeCount > 0 && <span className="text-text-secondary font-normal"> · {totalNodeCount} total</span>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/nodes"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-primary)] hover:underline"
            >
              View all
              <ExternalLink size={14} />
            </Link>
          </div>
        </div>
        {nodesLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader size={28} className="text-[var(--color-primary)] animate-spin" />
          </div>
        ) : !sortedNodes?.length ? (
          <div className="text-center py-12 text-text-secondary rounded-lg border border-dashed" style={{ borderColor: 'var(--color-border)' }}>
            No nodes found
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {sortedNodes.map((node) => {
              const cpuPct = toPercent(node.cpu_usage_percent);
              const memPct = toPercent(node.memory_usage_percent);
              const diskPct = toPercent(node.ephemeral_storage_usage_percent);
              const isReady = String(node.ready).toLowerCase() === 'true';
              return (
                <Link
                  key={node.name}
                  to="/nodes"
                  className="block rounded-xl border p-4 transition-all hover:border-[var(--color-primary)]/40 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                  style={{ backgroundColor: 'var(--color-bg)', borderColor: 'var(--color-border)' }}
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <span className="font-semibold text-text truncate min-w-0" title={node.name}>
                      {node.name}
                    </span>
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0"
                      style={{
                        background: isReady ? 'var(--color-status-ready-bg)' : 'var(--color-dashboard-danger-bg)',
                        color: isReady ? 'var(--color-status-ready)' : 'var(--color-dashboard-danger)',
                      }}
                    >
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'currentColor' }} />
                      {isReady ? 'Ready' : 'Not Ready'}
                    </span>
                  </div>
                  {node.roles?.length ? (
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {node.roles.map((role) => {
                        const roleStyle = getRoleBadgeStyle(role);
                        return (
                          <span
                            key={role}
                            className="inline-flex px-2 py-0.5 rounded-md text-xs font-medium border shrink-0"
                            style={{
                              backgroundColor: roleStyle.bg,
                              color: roleStyle.color,
                              borderColor: roleStyle.border,
                            }}
                          >
                            {role}
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                  {(() => {
                    const { ipv4, ipv6 } = getNodeIPv4IPv6(node);
                    const line = [ipv4, ipv6].filter(Boolean).join(' / ');
                    if (!line) return <div className="mb-4" />;
                    return (
                      <p className="text-xs font-mono text-text-secondary truncate mb-4" title={line}>
                        {line}
                      </p>
                    );
                  })()}
                  <div className="space-y-3">
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span style={{ color: 'var(--color-muted)' }}>CPU</span>
                        <span className="font-medium text-text truncate ml-1" title={node.cpu != null || node.cpu_used != null ? formatCpuRange(node.cpu_used, node.cpu) : undefined}>
                          {node.cpu != null || node.cpu_used != null
                            ? formatCpuRange(node.cpu_used, node.cpu)
                            : node.cpu_usage_percent != null
                              ? `${Math.round(cpuPct)}%`
                              : '—'}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--color-hover)' }}>
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${usageBarWidth(cpuPct)}%`,
                            backgroundColor: 'var(--color-dashboard-metric-primary)',
                          }}
                        />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span style={{ color: 'var(--color-muted)' }}>Memory</span>
                        <span className="font-medium text-text truncate ml-1" title={node.memory != null || node.memory_used != null ? formatMemoryUsedAlloc(node.memory_used, node.memory) : undefined}>
                          {node.memory != null || node.memory_used != null
                            ? formatMemoryUsedAlloc(node.memory_used, node.memory)
                            : node.memory_usage_percent != null
                              ? `${Math.round(memPct)}%`
                              : '—'}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--color-hover)' }}>
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${usageBarWidth(memPct)}%`,
                            backgroundColor: 'var(--color-dashboard-metric-quaternary)',
                          }}
                        />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span style={{ color: 'var(--color-muted)' }}>Disk</span>
                        <span className="font-medium text-text truncate ml-1" title={node.ephemeral_storage != null || node.ephemeral_storage_used != null ? formatK8sQuantityUsedAlloc(node.ephemeral_storage_used, node.ephemeral_storage) : undefined}>
                          {node.ephemeral_storage != null || node.ephemeral_storage_used != null
                            ? formatK8sQuantityUsedAlloc(node.ephemeral_storage_used, node.ephemeral_storage)
                            : node.ephemeral_storage_usage_percent != null
                              ? `${Math.round(diskPct)}%`
                              : '—'}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--color-hover)' }}>
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${usageBarWidth(diskPct)}%`,
                            backgroundColor: 'var(--color-dashboard-metric-tertiary)',
                          }}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 pt-3 border-t flex items-center justify-between text-xs" style={{ borderColor: 'var(--color-border)' }}>
                    <span className="truncate text-text-secondary" title={node.os_image ?? ''}>
                      {node.os_image ?? '—'}
                    </span>
                    <span className="font-mono text-text-secondary shrink-0 ml-2" title={node.kubelet_version ?? ''}>
                      {node.kubelet_version ?? '—'}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* Workload Summary */}
      <WorkloadSummary />

      {/* Metrics Charts */}
      <MetricsCharts />

      {/* Resource Usage Section - 3 Gauge Charts */}
      <div className="bg-surface border border-border rounded-lg p-6 backdrop-blur-sm">
        <div className="flex items-center gap-3 mb-6">
          <TrendingUp size={24} className="text-dashboard-metric-primary" />
          <h2 className="text-2xl font-bold text-text">Resource Usage</h2>
        </div>

        {!nodes || nodes.length === 0 ? (
          <div className="text-center py-8 text-text-secondary">No nodes found</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* CPU Panel */}
            <div className="bg-bg border border-border rounded-lg p-6 transition-all hover:shadow-md">
              <GaugeChart
                value={45}
                color="var(--color-dashboard-metric-primary)"
                label="CPU"
                used="4.5 cores"
                total="10 cores"
                icon={<Cpu size={20} className="text-dashboard-metric-primary" />}
              />
            </div>

            {/* Memory Panel */}
            <div className="bg-bg border border-border rounded-lg p-6 transition-all hover:shadow-md">
              <GaugeChart
                value={62}
                color="var(--color-dashboard-metric-secondary)"
                label="Memory"
                used="24 GB"
                total="40 GB"
                icon={<HardDrive size={20} className="text-dashboard-metric-secondary" />}
              />
            </div>

            {/* Disk Panel */}
            <div className="bg-bg border border-border rounded-lg p-6 transition-all hover:shadow-md">
              <GaugeChart
                value={38}
                color="var(--color-dashboard-metric-tertiary)"
                label="Disk"
                used="19 GB"
                total="50 GB"
                icon={<HardDrive size={20} className="text-dashboard-metric-tertiary" />}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
