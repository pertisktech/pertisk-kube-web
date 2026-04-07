import { memo, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Legend,
} from 'recharts';
import {
  Box,
  Layers,
  Database,
  Copy,
  Briefcase,
  Clock,
  RefreshCw,
  LayoutGrid,
  Circle,
  type IconComponent,
} from '../components/Icons';
import {
  useRealtimePods,
} from '../hooks/useRealtimePods';
import {
  useRealtimeDeployments,
  useRealtimeStatefulSets,
  useRealtimeDaemonSets,
  useRealtimeReplicaSets,
  useRealtimeJobs,
  useRealtimeCronJobs,
} from '../hooks/useRealtimeResources';
import { useNamespace } from '../context/NamespaceContext';
import type { Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob } from '../types';

// Workload overview uses its own modern teal accent to visually separate from dashboard cards.
const PIE_AND_THEME = {
  success: 'var(--color-workload-accent)',
  warning: 'var(--color-dashboard-warning)',
  danger: 'var(--color-dashboard-danger)',
  muted: 'var(--color-muted)',
} as const;

const STATUS_COLORS: Record<string, string> = {
  Running: PIE_AND_THEME.success,
  Healthy: PIE_AND_THEME.success,
  Active: PIE_AND_THEME.success,
  Complete: PIE_AND_THEME.success,
  Succeeded: PIE_AND_THEME.success,
  Completed: PIE_AND_THEME.success,
  Pending: PIE_AND_THEME.warning,
  Warning: PIE_AND_THEME.warning,
  Progressing: PIE_AND_THEME.warning,
  Degraded: PIE_AND_THEME.warning,
  Suspended: PIE_AND_THEME.muted,
  Stopped: PIE_AND_THEME.muted,
  Unknown: PIE_AND_THEME.muted,
  Failed: PIE_AND_THEME.danger,
  Error: PIE_AND_THEME.danger,
  CrashLoopBackOff: PIE_AND_THEME.danger,
};

// Parse "ready/total" string to [ready, total]
function parseReady(ready: string): [number, number] {
  const parts = (ready || '0/0').split('/').map((s) => parseInt(s.trim(), 10));
  const a = Number.isNaN(parts[0]) ? 0 : parts[0];
  const b = Number.isNaN(parts[1]) ? 0 : parts[1];
  return [a, b];
}

function getPodStatusData(pods: Pod[]): { name: string; value: number; color: string }[] {
  const statusCounts: Record<string, number> = {};
  pods.forEach((pod) => {
    const status = (pod.status || pod.phase || 'Unknown').trim();
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  });
  return Object.entries(statusCounts).map(([name, value]) => ({
    name,
    value,
    color: STATUS_COLORS[name] || STATUS_COLORS.Unknown,
  }));
}

function getDeploymentStatusData(
  deployments: Deployment[]
): { name: string; value: number; color: string }[] {
  const statusCounts = { Healthy: 0, Progressing: 0, Degraded: 0 };
  deployments.forEach((dep) => {
    const [ready, total] = parseReady(dep.ready);
    if (total > 0 && ready === total) statusCounts.Healthy++;
    else if (ready > 0) statusCounts.Progressing++;
    else statusCounts.Degraded++;
  });
  return Object.entries(statusCounts)
    .filter(([, value]) => value > 0)
    .map(([name, value]) => ({
      name,
      value,
      color: STATUS_COLORS[name] || STATUS_COLORS.Unknown,
    }));
}

function getDaemonSetStatusData(
  daemonsets: DaemonSet[]
): { name: string; value: number; color: string }[] {
  const statusCounts = { Healthy: 0, Progressing: 0, Degraded: 0 };
  daemonsets.forEach((ds) => {
    if (ds.desired > 0 && ds.ready === ds.desired) statusCounts.Healthy++;
    else if (ds.ready > 0) statusCounts.Progressing++;
    else statusCounts.Degraded++;
  });
  return Object.entries(statusCounts)
    .filter(([, value]) => value > 0)
    .map(([name, value]) => ({
      name,
      value,
      color: STATUS_COLORS[name] || STATUS_COLORS.Unknown,
    }));
}

function getStatefulSetStatusData(
  statefulsets: StatefulSet[]
): { name: string; value: number; color: string }[] {
  const statusCounts = { Healthy: 0, Progressing: 0, Degraded: 0 };
  statefulsets.forEach((sts) => {
    const [ready, total] = parseReady(sts.ready);
    if (total > 0 && ready === total) statusCounts.Healthy++;
    else if (ready > 0) statusCounts.Progressing++;
    else statusCounts.Degraded++;
  });
  return Object.entries(statusCounts)
    .filter(([, value]) => value > 0)
    .map(([name, value]) => ({
      name,
      value,
      color: STATUS_COLORS[name] || STATUS_COLORS.Unknown,
    }));
}

function getReplicaSetStatusData(
  replicasets: ReplicaSet[]
): { name: string; value: number; color: string }[] {
  const statusCounts = { Healthy: 0, Progressing: 0, Degraded: 0 };
  replicasets.forEach((rs) => {
    if (rs.desired > 0 && rs.ready === rs.desired) statusCounts.Healthy++;
    else if (rs.desired === 0) statusCounts.Healthy++;
    else if (rs.ready > 0) statusCounts.Progressing++;
    else statusCounts.Degraded++;
  });
  return Object.entries(statusCounts)
    .filter(([, value]) => value > 0)
    .map(([name, value]) => ({
      name,
      value,
      color: STATUS_COLORS[name] || STATUS_COLORS.Unknown,
    }));
}

function getJobStatusData(jobs: Job[]): { name: string; value: number; color: string }[] {
  const statusCounts = { Complete: 0, Running: 0, Failed: 0 };
  jobs.forEach((job) => {
    const s = (job.status || '').toLowerCase();
    if (s === 'completed' || s === 'succeeded') statusCounts.Complete++;
    else if (s === 'failed') statusCounts.Failed++;
    else statusCounts.Running++;
  });
  return Object.entries(statusCounts)
    .filter(([, value]) => value > 0)
    .map(([name, value]) => ({
      name,
      value,
      color: STATUS_COLORS[name === 'Complete' ? 'Complete' : name] || STATUS_COLORS.Unknown,
    }));
}

function getCronJobStatusData(
  cronjobs: CronJob[]
): { name: string; value: number; color: string }[] {
  const statusCounts = { Active: 0, Suspended: 0, Running: 0 };
  cronjobs.forEach((cj) => {
    if (cj.suspend) statusCounts.Suspended++;
    else if (cj.active > 0) statusCounts.Running++;
    else statusCounts.Active++;
  });
  return Object.entries(statusCounts)
    .filter(([, value]) => value > 0)
    .map(([name, value]) => ({
      name,
      value,
      color: STATUS_COLORS[name] || STATUS_COLORS.Unknown,
    }));
}

interface ChartCardProps {
  title: string;
  icon: IconComponent;
  data: { name: string; value: number; color: string }[];
  total: number;
  linkTo: string;
  isLoading: boolean;
}

function chartDataEqual(
  left: { name: string; value: number; color: string }[],
  right: { name: string; value: number; color: string }[]
) {
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];

    if (
      leftItem.name !== rightItem.name ||
      leftItem.value !== rightItem.value ||
      leftItem.color !== rightItem.color
    ) {
      return false;
    }
  }

  return true;
}

const ChartCard = memo(function ChartCard({ title, icon: Icon, data, total, linkTo, isLoading }: ChartCardProps) {
  const hasData = data.length > 0 && total > 0;

  return (
    <div className="bg-surface border border-border rounded-xl p-6 transition-all hover:shadow-lg backdrop-blur-sm">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-dashboard-metric-primary/20">
            <Icon size={20} className="text-dashboard-metric-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-text">{title}</h3>
            <p className="text-sm text-text-secondary">Total: {total}</p>
          </div>
        </div>
        <Link
          to={linkTo}
          className="text-sm px-3 py-1 rounded-lg hover:bg-hover transition-colors text-[var(--color-primary)]"
        >
          View All →
        </Link>
      </div>

      {isLoading ? (
        <div className="h-48 flex items-center justify-center">
          <RefreshCw size={24} className="animate-spin text-text-secondary" />
        </div>
      ) : !hasData ? (
        <div className="h-48 flex items-center justify-center">
          <p className="text-text-secondary">No resources found</p>
        </div>
      ) : (
        <div className="h-48 min-h-[192px] chart-theme-text">
          <ResponsiveContainer width="100%" height={192} minHeight={192}>
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={40}
                outerRadius={70}
                paddingAngle={2}
                dataKey="value"
                isAnimationActive={false}
                label={({ name, percent }) =>
                  (percent ?? 0) > 0.05 ? `${name ?? ''} (${((percent ?? 0) * 100).toFixed(0)}%)` : ''
                }
                labelLine={false}
              >
                {data.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--color-surface)',
                  color: 'var(--color-text)',
                  borderRadius: '8px',
                  padding: '10px 12px',
                }}
                labelStyle={{ color: 'var(--color-text)' }}
                itemStyle={{ color: 'var(--color-text)' }}
                wrapperStyle={{ outline: 'none' }}
                formatter={(value, name) => [
                  `${value} (${total > 0 ? ((Number(value) / total) * 100).toFixed(1) : 0}%)`,
                  name,
                ]}
              />
              <Legend
                wrapperStyle={{ fontSize: '12px', color: 'var(--color-text)' }}
                formatter={(value) => <span style={{ color: 'var(--color-text)' }}>{value}</span>}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}

      {hasData && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          {data.map((item) => (
            <div key={item.name} className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: item.color }}
              />
              <span className="text-sm text-text-secondary truncate">
                {item.name}: {item.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}, (previousProps, nextProps) => {
  return (
    previousProps.title === nextProps.title &&
    previousProps.icon === nextProps.icon &&
    previousProps.total === nextProps.total &&
    previousProps.linkTo === nextProps.linkTo &&
    previousProps.isLoading === nextProps.isLoading &&
    chartDataEqual(previousProps.data, nextProps.data)
  );
});

interface SummaryRowProps {
  name: string;
  icon: IconComponent;
  total: number;
  healthy: number;
  warning: number;
  critical: number;
  linkTo: string;
}

const SummaryRow = memo(function SummaryRow({
  name,
  icon: Icon,
  total,
  healthy,
  warning,
  critical,
  linkTo,
}: SummaryRowProps) {
  const cellContent = (
    <span className="flex items-center gap-2 text-text">
      <Icon size={16} className="text-dashboard-metric-primary flex-shrink-0" />
      <span>{name}</span>
    </span>
  );
  return (
    <tr className="border-b border-border hover:bg-hover/50 transition-colors">
      <td className="py-3 px-4">
        {linkTo && linkTo !== '#' ? (
          <Link
            to={linkTo}
            className="flex items-center gap-2 hover:text-[var(--color-primary)] transition-colors text-text"
          >
            <Icon size={16} className="text-dashboard-metric-primary flex-shrink-0" />
            <span>{name}</span>
          </Link>
        ) : (
          cellContent
        )}
      </td>
      <td className="text-center py-3 px-4 text-text tabular-nums">{total}</td>
      <td className="text-center py-3 px-4">
        <span
          className="px-2 py-1 rounded-full text-sm"
          style={
            healthy > 0
              ? { backgroundColor: 'var(--color-dashboard-metric-primary-bg)', color: 'var(--color-dashboard-metric-primary)' }
              : undefined
          }
        >
          {healthy}
        </span>
      </td>
      <td className="text-center py-3 px-4">
        <span
          className="px-2 py-1 rounded-full text-sm"
          style={
            warning > 0
              ? { backgroundColor: 'var(--color-dashboard-warning-bg)', color: 'var(--color-dashboard-warning)' }
              : undefined
          }
        >
          {warning}
        </span>
      </td>
      <td className="text-center py-3 px-4">
        <span
          className="px-2 py-1 rounded-full text-sm"
          style={
            critical > 0
              ? { backgroundColor: 'var(--color-dashboard-danger-bg)', color: 'var(--color-dashboard-danger)' }
              : undefined
          }
        >
          {critical}
        </span>
      </td>
    </tr>
  );
});

export const WorkloadsOverviewPage = () => {
  const { selectedNamespaces } = useNamespace();

  // Realtime workload data (WebSocket)
  const { data: pods, isConnected: podsConnected } = useRealtimePods<Pod>();
  const { data: deployments, isLoading: deploymentsLoading } = useRealtimeDeployments();
  const { data: statefulsets, isLoading: statefulsetsLoading } = useRealtimeStatefulSets();
  const { data: daemonsets, isLoading: daemonsetsLoading } = useRealtimeDaemonSets();
  const { data: replicasets, isLoading: replicasetsLoading } = useRealtimeReplicaSets();
  const { data: jobs, isLoading: jobsLoading } = useRealtimeJobs();
  const { data: cronjobs, isLoading: cronjobsLoading } = useRealtimeCronJobs();

  const podsLoading = !podsConnected && pods.length === 0;
  const workloadRealtimeConnected =
    podsConnected &&
    !deploymentsLoading &&
    !statefulsetsLoading &&
    !daemonsetsLoading &&
    !replicasetsLoading &&
    !jobsLoading &&
    !cronjobsLoading;

  const filterByNs = <T extends { namespace?: string }>(list: T[] | undefined): T[] => {
    if (!list) return [];
    if (selectedNamespaces.length === 0) return list;
    return list.filter((x) => selectedNamespaces.includes(x.namespace ?? ''));
  };

  const filteredPods = useMemo(() => filterByNs(pods ?? []), [pods, selectedNamespaces]);
  const filteredDeployments = useMemo(
    () => filterByNs(deployments ?? []),
    [deployments, selectedNamespaces]
  );
  const filteredStatefulSets = useMemo(
    () => filterByNs(statefulsets ?? []),
    [statefulsets, selectedNamespaces]
  );
  const filteredDaemonSets = useMemo(
    () => filterByNs(daemonsets ?? []),
    [daemonsets, selectedNamespaces]
  );
  const filteredReplicaSets = useMemo(
    () => filterByNs(replicasets ?? []),
    [replicasets, selectedNamespaces]
  );
  const filteredJobs = useMemo(() => filterByNs(jobs ?? []), [jobs, selectedNamespaces]);
  const filteredCronJobs = useMemo(
    () => filterByNs(cronjobs ?? []),
    [cronjobs, selectedNamespaces]
  );

  const podChartData = useMemo(() => getPodStatusData(filteredPods), [filteredPods]);
  const deploymentChartData = useMemo(
    () => getDeploymentStatusData(filteredDeployments),
    [filteredDeployments]
  );
  const daemonSetChartData = useMemo(
    () => getDaemonSetStatusData(filteredDaemonSets),
    [filteredDaemonSets]
  );
  const statefulSetChartData = useMemo(
    () => getStatefulSetStatusData(filteredStatefulSets),
    [filteredStatefulSets]
  );
  const replicaSetChartData = useMemo(
    () => getReplicaSetStatusData(filteredReplicaSets),
    [filteredReplicaSets]
  );
  const jobChartData = useMemo(() => getJobStatusData(filteredJobs), [filteredJobs]);
  const cronJobChartData = useMemo(
    () => getCronJobStatusData(filteredCronJobs),
    [filteredCronJobs]
  );

  const totalWorkloads =
    filteredPods.length +
    filteredDeployments.length +
    filteredStatefulSets.length +
    filteredDaemonSets.length +
    filteredReplicaSets.length +
    filteredJobs.length +
    filteredCronJobs.length;

  const healthyCount =
    filteredPods.filter((p) => (p.status || p.phase || '').toLowerCase() === 'running').length +
    filteredDeployments.filter((d) => {
      const [ready, total] = parseReady(d.ready);
      return total > 0 && ready === total;
    }).length +
    filteredDaemonSets.filter((ds) => ds.desired > 0 && ds.ready === ds.desired).length +
    filteredStatefulSets.filter((sts) => {
      const [ready, total] = parseReady(sts.ready);
      return total > 0 && ready === total;
    }).length;

  const healthPercentage =
    totalWorkloads > 0 ? ((healthyCount / totalWorkloads) * 100).toFixed(1) : '0';
  const healthNum = parseFloat(healthPercentage);
  const healthColorStyle =
    healthNum >= 80
      ? { color: 'var(--color-dashboard-metric-primary)' }
      : healthNum >= 50
        ? { color: 'var(--color-dashboard-warning)' }
        : { color: 'var(--color-dashboard-danger)' };

  return (
    <div className="space-y-6">
      {/* Header - same as pertisk-kube */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text flex items-center gap-2">
            <LayoutGrid size={28} className="text-dashboard-metric-primary" />
            Workload Overview
          </h1>
          <p className="text-text-secondary mt-1">
            Monitor all workload resources across your cluster
          </p>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          {workloadRealtimeConnected && (
            <span
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-medium"
              style={{ backgroundColor: 'var(--color-dashboard-metric-primary-bg)', color: 'var(--color-dashboard-metric-primary)' }}
            >
              <Circle size={8} className="fill-current animate-pulse" />
              Live
            </span>
          )}
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-surface border border-border">
            <span className="text-text-secondary">Total Workloads: </span>
            <span className="font-bold text-text tabular-nums">{totalWorkloads}</span>
            <span className="text-border mx-2">|</span>
            <span className="text-text-secondary">Health: </span>
            <span className="font-bold tabular-nums" style={healthColorStyle}>{healthPercentage}%</span>
          </div>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        <ChartCard
          title="Pods"
          icon={Box}
          data={podChartData}
          total={filteredPods.length}
          linkTo="/pods"
          isLoading={podsLoading}
        />
        <ChartCard
          title="Deployments"
          icon={Layers}
          data={deploymentChartData}
          total={filteredDeployments.length}
          linkTo="/deployments"
          isLoading={deploymentsLoading}
        />
        <ChartCard
          title="DaemonSets"
          icon={Layers}
          data={daemonSetChartData}
          total={filteredDaemonSets.length}
          linkTo="/daemonsets"
          isLoading={daemonsetsLoading}
        />
        <ChartCard
          title="StatefulSets"
          icon={Database}
          data={statefulSetChartData}
          total={filteredStatefulSets.length}
          linkTo="/statefulsets"
          isLoading={statefulsetsLoading}
        />
        <ChartCard
          title="ReplicaSets"
          icon={Copy}
          data={replicaSetChartData}
          total={filteredReplicaSets.length}
          linkTo="/replicasets"
          isLoading={replicasetsLoading}
        />
        <ChartCard
          title="Jobs"
          icon={Briefcase}
          data={jobChartData}
          total={filteredJobs.length}
          linkTo="/jobs"
          isLoading={jobsLoading}
        />
        <ChartCard
          title="CronJobs"
          icon={Clock}
          data={cronJobChartData}
          total={filteredCronJobs.length}
          linkTo="/cronjobs"
          isLoading={cronjobsLoading}
        />
      </div>

      {/* Resource Summary — workloads only */}
      <div className="bg-surface border border-border rounded-xl p-6 backdrop-blur-sm">
        <h2 className="text-lg font-semibold text-text mb-4">Resource Summary</h2>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-3 px-4 text-text-secondary font-medium">
                  Resource Type
                </th>
                <th className="text-center py-3 px-4 text-text-secondary font-medium">Total</th>
                <th className="text-center py-3 px-4 font-medium" style={{ color: 'var(--color-dashboard-metric-primary)' }}>
                  Healthy
                </th>
                <th className="text-center py-3 px-4 font-medium" style={{ color: 'var(--color-dashboard-warning)' }}>
                  Warning
                </th>
                <th className="text-center py-3 px-4 font-medium" style={{ color: 'var(--color-dashboard-danger)' }}>
                  Critical
                </th>
              </tr>
            </thead>
            <tbody>
              <SummaryRow
                name="Pods"
                icon={Box}
                total={filteredPods.length}
                healthy={filteredPods.filter((p) => (p.status || p.phase || '').toLowerCase() === 'running').length}
                warning={filteredPods.filter((p) => (p.status || p.phase || '').toLowerCase() === 'pending').length}
                critical={filteredPods.filter((p) =>
                  ['failed', 'crashloopbackoff', 'error'].includes((p.status || p.phase || '').toLowerCase())
                ).length}
                linkTo="/pods"
              />
              <SummaryRow
                name="Deployments"
                icon={Layers}
                total={filteredDeployments.length}
                healthy={filteredDeployments.filter((d) => {
                  const [ready, total] = parseReady(d.ready);
                  return total > 0 && ready === total;
                }).length}
                warning={filteredDeployments.filter((d) => {
                  const [ready, total] = parseReady(d.ready);
                  return total > 0 && ready > 0 && ready < total;
                }).length}
                critical={filteredDeployments.filter((d) => {
                  const [ready, total] = parseReady(d.ready);
                  return total > 0 && ready === 0;
                }).length}
                linkTo="/deployments"
              />
              <SummaryRow
                name="DaemonSets"
                icon={Layers}
                total={filteredDaemonSets.length}
                healthy={filteredDaemonSets.filter((ds) => ds.desired > 0 && ds.ready === ds.desired).length}
                warning={filteredDaemonSets.filter((ds) => ds.ready > 0 && ds.ready < ds.desired).length}
                critical={filteredDaemonSets.filter((ds) => ds.desired > 0 && ds.ready === 0).length}
                linkTo="/daemonsets"
              />
              <SummaryRow
                name="StatefulSets"
                icon={Database}
                total={filteredStatefulSets.length}
                healthy={filteredStatefulSets.filter((sts) => {
                  const [ready, total] = parseReady(sts.ready);
                  return total > 0 && ready === total;
                }).length}
                warning={filteredStatefulSets.filter((sts) => {
                  const [ready, total] = parseReady(sts.ready);
                  return total > 0 && ready > 0 && ready < total;
                }).length}
                critical={filteredStatefulSets.filter((sts) => {
                  const [ready, total] = parseReady(sts.ready);
                  return total > 0 && ready === 0;
                }).length}
                linkTo="/statefulsets"
              />
              <SummaryRow
                name="ReplicaSets"
                icon={Copy}
                total={filteredReplicaSets.length}
                healthy={filteredReplicaSets.filter((rs) => rs.desired === 0 || rs.ready === rs.desired).length}
                warning={filteredReplicaSets.filter((rs) => rs.ready > 0 && rs.ready < rs.desired).length}
                critical={filteredReplicaSets.filter((rs) => rs.desired > 0 && rs.ready === 0).length}
                linkTo="/replicasets"
              />
              <SummaryRow
                name="Jobs"
                icon={Briefcase}
                total={filteredJobs.length}
                healthy={filteredJobs.filter((j) => (j.status || '').toLowerCase() === 'completed').length}
                warning={filteredJobs.filter((j) => (j.status || '').toLowerCase() === 'running').length}
                critical={filteredJobs.filter((j) => (j.status || '').toLowerCase() === 'failed').length}
                linkTo="/jobs"
              />
              <SummaryRow
                name="CronJobs"
                icon={Clock}
                total={filteredCronJobs.length}
                healthy={filteredCronJobs.filter((cj) => !cj.suspend).length}
                warning={0}
                critical={filteredCronJobs.filter((cj) => cj.suspend).length}
                linkTo="/cronjobs"
              />
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
