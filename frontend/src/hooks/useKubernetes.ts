import { useQuery } from '@tanstack/react-query';
import type {
  Namespace,
  Pod,
  Deployment,
  StatefulSet,
  DaemonSet,
  ReplicaSet,
  Job,
  CronJob,
  KubernetesEvent,
  K8sNode,
  DashboardSummary,
  BackupSettings,
  BackupOverview,
  ApiResponse,
  ConfigMap,
  Secret,
  ResourceQuota,
  LimitRange,
  HPA,
  PDB,
  PriorityClass,
  RuntimeClass,
  Lease,
  Service,
  Endpoint,
  Ingress,
  IngressClass,
  NetworkPolicy,
  PersistentVolume,
  PersistentVolumeClaim,
  StorageClass,
  ServiceAccount,
  Role,
  RoleBinding,
  ClusterRole,
  ClusterRoleBinding,
  Crd,
  CustomResource,
  HelmRelease,
  HelmChart,
  HelmRevision,
  HelmResource,
  ResourceMapData,
  WorkloadMetricSeriesResponse,
} from '../types';
import { getAuthToken } from '../utils/auth';

const API_BASE = '/api';

const apiFetch = async (path: string) => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    headers: token
      ? {
          Authorization: token,
        }
      : undefined,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
  }
  return res;
};

export const useNamespaces = () => {
  return useQuery({
    queryKey: ['namespaces'],
    queryFn: async () => {
      const res = await apiFetch('/namespaces');
      if (!res.ok) throw new Error('Failed to fetch namespaces');
      const data = (await res.json()) as ApiResponse<Namespace>;
      return data.data;
    },
  });
};

export const usePods = () => {
  return useQuery({
    queryKey: ['pods'],
    queryFn: async () => {
      const res = await apiFetch('/pods');
      if (!res.ok) throw new Error('Failed to fetch pods');
      const data = (await res.json()) as ApiResponse<Pod>;
      return data.data;
    },
  });
};

export const useWorkloadMetricSeries = (durationHours: number = 1) => {
  const allowedDurations = new Set([1, 2, 4, 24, 48, 168, 720]);
  const normalizedDuration = allowedDurations.has(durationHours) ? durationHours : 1;

  return useQuery({
    queryKey: ['workload-metric-series', normalizedDuration],
    queryFn: async () => {
      const res = await apiFetch(`/metrics/workloads/series?duration_hours=${normalizedDuration}`);
      if (!res.ok) throw new Error('Failed to fetch workload metric series');
      return (await res.json()) as WorkloadMetricSeriesResponse;
    },
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });
};

export const useDeployments = () => {
  return useQuery({
    queryKey: ['deployments'],
    queryFn: async () => {
      const res = await apiFetch('/deployments');
      if (!res.ok) throw new Error('Failed to fetch deployments');
      const data = (await res.json()) as ApiResponse<Deployment>;
      return data.data;
    },
  });
};

export const useStatefulSets = () => {
  return useQuery({
    queryKey: ['statefulsets'],
    queryFn: async () => {
      const res = await apiFetch('/statefulsets');
      if (!res.ok) throw new Error('Failed to fetch statefulsets');
      const data = (await res.json()) as ApiResponse<StatefulSet>;
      return data.data;
    },
  });
};

export const useDaemonSets = () => {
  return useQuery({
    queryKey: ['daemonsets'],
    queryFn: async () => {
      const res = await apiFetch('/daemonsets');
      if (!res.ok) throw new Error('Failed to fetch daemonsets');
      const data = (await res.json()) as ApiResponse<DaemonSet>;
      return data.data;
    },
  });
};

export const useReplicaSets = () => {
  return useQuery({
    queryKey: ['replicasets'],
    queryFn: async () => {
      const res = await apiFetch('/replicasets');
      if (!res.ok) throw new Error('Failed to fetch replicasets');
      const data = (await res.json()) as ApiResponse<ReplicaSet>;
      return data.data;
    },
  });
};

export const useJobs = () => {
  return useQuery({
    queryKey: ['jobs'],
    queryFn: async () => {
      const res = await apiFetch('/jobs');
      if (!res.ok) throw new Error('Failed to fetch jobs');
      const data = (await res.json()) as ApiResponse<Job>;
      return data.data;
    },
  });
};

export const useCronJobs = () => {
  return useQuery({
    queryKey: ['cronjobs'],
    queryFn: async () => {
      const res = await apiFetch('/cronjobs');
      if (!res.ok) throw new Error('Failed to fetch cronjobs');
      const data = (await res.json()) as ApiResponse<CronJob>;
      return data.data;
    },
  });
};

export const useEvents = () => {
  return useQuery({
    queryKey: ['events'],
    queryFn: async () => {
      const res = await apiFetch('/events');
      if (!res.ok) throw new Error('Failed to fetch events');
      const data = (await res.json()) as ApiResponse<KubernetesEvent>;
      return data.data;
    },
  });
};

export const useNodes = (options?: { refetchInterval?: number }) => {
  return useQuery({
    queryKey: ['nodes'],
    queryFn: async () => {
      const res = await apiFetch('/nodes');
      if (!res.ok) throw new Error('Failed to fetch nodes');
      const data = (await res.json()) as ApiResponse<K8sNode>;
      return data.data;
    },
    refetchInterval: options?.refetchInterval,
  });
};

export const useDashboard = () => {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const res = await apiFetch('/dashboard');
      if (!res.ok) throw new Error('Failed to fetch dashboard summary');
      const data = (await res.json()) as DashboardSummary;
      return data;
    },
  });
};

export const useBackupSettings = () => {
  return useQuery({
    queryKey: ['backup-settings'],
    queryFn: async () => {
      const res = await apiFetch('/backup/config');
      if (!res.ok) throw new Error('Failed to fetch backup settings');
      return (await res.json()) as BackupSettings;
    },
  });
};

export const useBackupOverview = (options?: { enabled?: boolean; refetchInterval?: number }) => {
  return useQuery({
    queryKey: ['backup-overview'],
    queryFn: async () => {
      const res = await apiFetch(`/backup/overview?_t=${Date.now()}`);
      if (!res.ok) throw new Error('Failed to fetch backup overview');
      return (await res.json()) as BackupOverview;
    },
    refetchInterval: options?.refetchInterval ?? 15000,
    enabled: options?.enabled ?? true,
  });
};

export const saveBackupSettings = async (settings: BackupSettings): Promise<void> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/backup/config`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify(settings),
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Failed to save settings (${res.status})`);
  }
};

export interface SaveBackupS3ConfigRequest {
  storage_location_name: string;
  credentials_secret_name: string;
  s3_bucket: string;
  s3_region: string;
  s3_prefix: string;
  s3_url: string;
  s3_force_path_style: boolean;
  s3_insecure_skip_tls_verify: boolean;
  aws_access_key_id: string;
  aws_secret_access_key: string;
}

export const saveBackupS3Config = async (settings: SaveBackupS3ConfigRequest): Promise<void> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/backup/config/s3`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify(settings),
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Failed to save S3 config (${res.status})`);
  }
};

export const applyBackupSettings = async (): Promise<string> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/backup/config/apply`, {
    method: 'POST',
    headers: token ? { Authorization: token } : undefined,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Failed to apply settings (${res.status})`);
  }
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  return body.message || 'Backup settings applied.';
};

export interface TestBackupS3Request {
  s3_bucket: string;
  s3_region: string;
  s3_prefix: string;
  s3_url: string;
  s3_force_path_style: boolean;
  s3_insecure_skip_tls_verify: boolean;
  aws_access_key_id: string;
  aws_secret_access_key: string;
}

export const testBackupS3 = async (payload: TestBackupS3Request): Promise<string> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/backup/config/test-s3`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
  if (!res.ok || !body.success) {
    throw new Error(body.message || `Failed to test S3 (${res.status})`);
  }
  return body.message || 'S3 connectivity test passed.';
};

export interface ManualBackupRequest {
  name?: string;
  include_namespaces?: string[];
  exclude_namespaces?: string[];
}

export const runManualBackup = async (payload: ManualBackupRequest): Promise<string> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/backup/manual`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; name?: string; message?: string };
  if (!res.ok || !body.success) {
    throw new Error(body.message || `Failed to run backup (${res.status})`);
  }
  return body.name || '';
};

export interface RestoreBackupRequest {
  backup_name: string;
  restore_name?: string;
  include_namespaces?: string[];
  exclude_namespaces?: string[];
}

export interface CreateBackupScheduleRequest {
  name: string;
  cron: string;
  timezone?: string;
  ttl?: string;
  include_namespaces?: string[];
  exclude_namespaces?: string[];
  paused?: boolean;
}

export const runRestoreBackup = async (payload: RestoreBackupRequest): Promise<string> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/backup/restore`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; name?: string; message?: string };
  if (!res.ok || !body.success) {
    throw new Error(body.message || `Failed to run restore (${res.status})`);
  }
  return body.name || '';
};

export const createBackupSchedule = async (payload: CreateBackupScheduleRequest): Promise<string> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/backup/schedules`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; name?: string; message?: string };
  if (!res.ok || !body.success) {
    throw new Error(body.message || `Failed to create schedule (${res.status})`);
  }
  return body.name || payload.name;
};

export const deleteBackupSchedule = async (name: string): Promise<void> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/backup/schedules/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: token ? { Authorization: token } : undefined,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
  if (!res.ok || !body.success) {
    throw new Error(body.message || `Failed to delete schedule (${res.status})`);
  }
};

export const runBackupScheduleNow = async (name: string): Promise<string> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/backup/schedules/${encodeURIComponent(name)}/run`, {
    method: 'POST',
    headers: token ? { Authorization: token } : undefined,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; name?: string; message?: string };
  if (!res.ok || !body.success) {
    throw new Error(body.message || `Failed to run schedule (${res.status})`);
  }
  return body.name || name;
};

export const deleteBackupRun = async (name: string): Promise<string> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/backup/backups/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: token ? { Authorization: token } : undefined,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
  if (!res.ok || !body.success) {
    throw new Error(body.message || `Failed to delete backup (${res.status})`);
  }
  return body.message || `Deleted backup ${name}`;
};

export const downloadBackupRun = async (name: string): Promise<void> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/backup/backups/${encodeURIComponent(name)}`, {
    method: 'GET',
    headers: token ? { Authorization: token } : undefined,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Failed to download backup (${res.status})`);
  }

  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const filenameMatch = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  const filename = filenameMatch?.[1] || `${name}.json`;

  const url = window.URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    window.URL.revokeObjectURL(url);
  }
};

export const deleteBackupRunsBulk = async (names: string[]): Promise<{ message: string; deleted: number; warnings: string[] }> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/backup/backups/delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify({ names }),
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; deleted?: number; warnings?: string[] };
  if (!res.ok || !body.success) {
    throw new Error(body.message || `Failed to delete backups (${res.status})`);
  }
  return {
    message: body.message || `Deleted ${names.length} backups`,
    deleted: body.deleted ?? 0,
    warnings: body.warnings ?? [],
  };
};

// Config Resources
export const useConfigMaps = () => {
  return useQuery({
    queryKey: ['configmaps'],
    queryFn: async () => {
      const res = await apiFetch('/configmaps');
      if (!res.ok) throw new Error('Failed to fetch configmaps');
      const data = (await res.json()) as ApiResponse<ConfigMap>;
      return data.data;
    },
  });
};

export const useSecrets = () => {
  return useQuery({
    queryKey: ['secrets'],
    queryFn: async () => {
      const res = await apiFetch('/secrets');
      if (!res.ok) throw new Error('Failed to fetch secrets');
      const data = (await res.json()) as ApiResponse<Secret>;
      return data.data;
    },
  });
};

export const fetchSecretData = async (namespace: string, name: string): Promise<Record<string, string> | null> => {
  try {
    const res = await apiFetch(
      `/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/data`
    );
    if (!res.ok) return null;

    const payload = await res.json();
    const secretData = payload?.data;
    if (!secretData || typeof secretData !== 'object') {
      return null;
    }

    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(secretData)) {
      if (typeof value === 'string') {
        normalized[key] = value;
      }
    }
    return normalized;
  } catch {
    return null;
  }
};

export const useResourceQuotas = () => {
  return useQuery({
    queryKey: ['resourcequotas'],
    queryFn: async () => {
      const res = await apiFetch('/resourcequotas');
      if (!res.ok) throw new Error('Failed to fetch resourcequotas');
      const data = (await res.json()) as ApiResponse<ResourceQuota>;
      return data.data;
    },
  });
};

export const useLimitRanges = () => {
  return useQuery({
    queryKey: ['limitranges'],
    queryFn: async () => {
      const res = await apiFetch('/limitranges');
      if (!res.ok) throw new Error('Failed to fetch limitranges');
      const data = (await res.json()) as ApiResponse<LimitRange>;
      return data.data;
    },
  });
};

export const useHPA = () => {
  return useQuery({
    queryKey: ['hpa'],
    queryFn: async () => {
      const res = await apiFetch('/hpa');
      if (!res.ok) throw new Error('Failed to fetch hpa');
      const data = (await res.json()) as ApiResponse<HPA>;
      return data.data;
    },
  });
};

export const usePDB = () => {
  return useQuery({
    queryKey: ['pdb'],
    queryFn: async () => {
      const res = await apiFetch('/pdb');
      if (!res.ok) throw new Error('Failed to fetch pdb');
      const data = (await res.json()) as ApiResponse<PDB>;
      return data.data;
    },
  });
};

export const usePriorityClasses = () => {
  return useQuery({
    queryKey: ['priorityclasses'],
    queryFn: async () => {
      const res = await apiFetch('/priorityclasses');
      if (!res.ok) throw new Error('Failed to fetch priorityclasses');
      const data = (await res.json()) as ApiResponse<PriorityClass>;
      return data.data;
    },
  });
};

export const useRuntimeClasses = () => {
  return useQuery({
    queryKey: ['runtimeclasses'],
    queryFn: async () => {
      const res = await apiFetch('/runtimeclasses');
      if (!res.ok) throw new Error('Failed to fetch runtimeclasses');
      const data = (await res.json()) as ApiResponse<RuntimeClass>;
      return data.data;
    },
  });
};

export const useLeases = () => {
  return useQuery({
    queryKey: ['leases'],
    queryFn: async () => {
      const res = await apiFetch('/leases');
      if (!res.ok) throw new Error('Failed to fetch leases');
      const data = (await res.json()) as ApiResponse<Lease>;
      return data.data;
    },
  });
};

// Network Resources
export const useServices = () => {
  return useQuery({
    queryKey: ['services'],
    queryFn: async () => {
      const res = await apiFetch('/services');
      if (!res.ok) throw new Error('Failed to fetch services');
      const data = (await res.json()) as ApiResponse<Service>;
      return data.data;
    },
  });
};

export const useEndpoints = () => {
  return useQuery({
    queryKey: ['endpoints'],
    queryFn: async () => {
      const res = await apiFetch('/endpoints');
      if (!res.ok) throw new Error('Failed to fetch endpoints');
      const data = (await res.json()) as ApiResponse<Endpoint>;
      return data.data;
    },
  });
};

export const useIngresses = () => {
  return useQuery({
    queryKey: ['ingresses'],
    queryFn: async () => {
      const res = await apiFetch('/ingresses');
      if (!res.ok) throw new Error('Failed to fetch ingresses');
      const data = (await res.json()) as ApiResponse<Ingress>;
      return data.data;
    },
  });
};

export const useIngressClasses = () => {
  return useQuery({
    queryKey: ['ingressclasses'],
    queryFn: async () => {
      const res = await apiFetch('/ingressclasses');
      if (!res.ok) throw new Error('Failed to fetch ingress classes');
      const data = (await res.json()) as ApiResponse<IngressClass>;
      return data.data;
    },
  });
};

export const useNetworkPolicies = () => {
  return useQuery({
    queryKey: ['networkpolicies'],
    queryFn: async () => {
      const res = await apiFetch('/networkpolicies');
      if (!res.ok) throw new Error('Failed to fetch network policies');
      const data = (await res.json()) as ApiResponse<NetworkPolicy>;
      return data.data;
    },
  });
};

// Storage Resources
export const usePersistentVolumes = () => {
  return useQuery({
    queryKey: ['persistentvolumes'],
    queryFn: async () => {
      const res = await apiFetch('/persistentvolumes');
      if (!res.ok) throw new Error('Failed to fetch persistent volumes');
      const data = (await res.json()) as ApiResponse<PersistentVolume>;
      return data.data;
    },
  });
};

export const usePersistentVolumeClaims = () => {
  return useQuery({
    queryKey: ['persistentvolumeclaims'],
    queryFn: async () => {
      const res = await apiFetch('/persistentvolumeclaims');
      if (!res.ok) throw new Error('Failed to fetch persistent volume claims');
      const data = (await res.json()) as ApiResponse<PersistentVolumeClaim>;
      return data.data;
    },
  });
};

export const useStorageClasses = () => {
  return useQuery({
    queryKey: ['storageclasses'],
    queryFn: async () => {
      const res = await apiFetch('/storageclasses');
      if (!res.ok) throw new Error('Failed to fetch storage classes');
      const data = (await res.json()) as ApiResponse<StorageClass>;
      return data.data;
    },
  });
};

// Access Control (RBAC) Resources
export const useServiceAccounts = () => {
  return useQuery({
    queryKey: ['serviceaccounts'],
    queryFn: async () => {
      const res = await apiFetch('/serviceaccounts');
      if (!res.ok) throw new Error('Failed to fetch service accounts');
      const data = (await res.json()) as ApiResponse<ServiceAccount>;
      return data.data;
    },
  });
};

export const useRoles = () => {
  return useQuery({
    queryKey: ['roles'],
    queryFn: async () => {
      const res = await apiFetch('/roles');
      if (!res.ok) throw new Error('Failed to fetch roles');
      const data = (await res.json()) as ApiResponse<Role>;
      return data.data;
    },
  });
};

export const useRoleBindings = () => {
  return useQuery({
    queryKey: ['rolebindings'],
    queryFn: async () => {
      const res = await apiFetch('/rolebindings');
      if (!res.ok) throw new Error('Failed to fetch role bindings');
      const data = (await res.json()) as ApiResponse<RoleBinding>;
      return data.data;
    },
  });
};

export const useClusterRoles = () => {
  return useQuery({
    queryKey: ['clusterroles'],
    queryFn: async () => {
      const res = await apiFetch('/clusterroles');
      if (!res.ok) throw new Error('Failed to fetch cluster roles');
      const data = (await res.json()) as ApiResponse<ClusterRole>;
      return data.data;
    },
  });
};

export const useClusterRoleBindings = () => {
  return useQuery({
    queryKey: ['clusterrolebindings'],
    queryFn: async () => {
      const res = await apiFetch('/clusterrolebindings');
      if (!res.ok) throw new Error('Failed to fetch cluster role bindings');
      const data = (await res.json()) as ApiResponse<ClusterRoleBinding>;
      return data.data;
    },
  });
};

export const scaleDeployment = async (namespace: string, name: string, replicas: number): Promise<void> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/deployments/${namespace}/${name}/scale`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify({ replicas }),
  });

  if (!res.ok) {
    throw new Error('Failed to scale deployment');
  }
};

export const restartDeployment = async (namespace: string, name: string): Promise<void> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/deployments/${namespace}/${name}/restart`, {
    method: 'POST',
    headers: token ? { Authorization: token } : undefined,
  });

  if (!res.ok) {
    throw new Error('Failed to restart deployment');
  }
};

export const quickUpdateDeploymentImageTag = async (
  namespace: string,
  name: string,
  tag: string,
  image?: string
): Promise<void> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/deployments/${namespace}/${name}/image-tag`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify({ tag, image }),
  });

  if (!res.ok) {
    let message = 'Failed to update deployment image tag';
    try {
      const payload = await res.json();
      if (typeof payload?.message === 'string' && payload.message.length > 0) {
        message = payload.message;
      }
    } catch {
      // ignore json parse errors and keep default message
    }
    throw new Error(message);
  }
};

const apiDelete = async (path: string): Promise<void> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: token ? { Authorization: token } : undefined,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    return;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Delete failed (${res.status})`);
  }
};

export const deletePod = (namespace: string, name: string) =>
  apiDelete(`/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteDeployment = (namespace: string, name: string) =>
  apiDelete(`/deployments/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteStatefulSet = (namespace: string, name: string) =>
  apiDelete(`/statefulsets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteDaemonSet = (namespace: string, name: string) =>
  apiDelete(`/daemonsets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteReplicaSet = (namespace: string, name: string) =>
  apiDelete(`/replicasets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteJob = (namespace: string, name: string) =>
  apiDelete(`/jobs/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteCronJob = (namespace: string, name: string) =>
  apiDelete(`/cronjobs/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteNamespace = (name: string) =>
  apiDelete(`/namespaces/${encodeURIComponent(name)}`);

// Config resources
export const deleteConfigMap = (namespace: string, name: string) =>
  apiDelete(`/configmaps/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteSecret = (namespace: string, name: string) =>
  apiDelete(`/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteResourceQuota = (namespace: string, name: string) =>
  apiDelete(`/resourcequotas/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteLimitRange = (namespace: string, name: string) =>
  apiDelete(`/limitranges/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteHPA = (namespace: string, name: string) =>
  apiDelete(`/hpa/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deletePDB = (namespace: string, name: string) =>
  apiDelete(`/pdb/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteLease = (namespace: string, name: string) =>
  apiDelete(`/leases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

// Cluster-scoped config resources
export const deletePriorityClass = (name: string) =>
  apiDelete(`/priorityclasses/${encodeURIComponent(name)}`);

export const deleteRuntimeClass = (name: string) =>
  apiDelete(`/runtimeclasses/${encodeURIComponent(name)}`);

export const deleteMwc = (name: string) =>
  apiDelete(`/mwcs/${encodeURIComponent(name)}`);

export const deleteVwc = (name: string) =>
  apiDelete(`/vwcs/${encodeURIComponent(name)}`);

// Network resources
export const deleteService = (namespace: string, name: string) =>
  apiDelete(`/services/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteEndpoint = (namespace: string, name: string) =>
  apiDelete(`/endpoints/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteIngress = (namespace: string, name: string) =>
  apiDelete(`/ingresses/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteNetworkPolicy = (namespace: string, name: string) =>
  apiDelete(`/networkpolicies/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

// Cluster-scoped network resources
export const deleteIngressClass = (name: string) =>
  apiDelete(`/ingressclasses/${encodeURIComponent(name)}`);

// RBAC resources
export const deleteServiceAccount = (namespace: string, name: string) =>
  apiDelete(`/serviceaccounts/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteRole = (namespace: string, name: string) =>
  apiDelete(`/roles/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteRoleBinding = (namespace: string, name: string) =>
  apiDelete(`/rolebindings/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deleteClusterRole = (name: string) =>
  apiDelete(`/clusterroles/${encodeURIComponent(name)}`);

export const deleteClusterRoleBinding = (name: string) =>
  apiDelete(`/clusterrolebindings/${encodeURIComponent(name)}`);

// Storage resources
export const deletePersistentVolumeClaim = (namespace: string, name: string) =>
  apiDelete(`/persistentvolumeclaims/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);

export const deletePersistentVolume = (name: string) =>
  apiDelete(`/persistentvolumes/${encodeURIComponent(name)}`);

export const deleteStorageClass = (name: string) =>
  apiDelete(`/storageclasses/${encodeURIComponent(name)}`);

// Node operations
export const deleteNode = (name: string) =>
  apiDelete(`/nodes/${encodeURIComponent(name)}`);

export const cordonNode = async (name: string): Promise<void> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/nodes/${encodeURIComponent(name)}/cordon`, {
    method: 'POST',
    headers: token ? { Authorization: token } : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Cordon failed (${res.status})`);
  }
};

export const uncordonNode = async (name: string): Promise<void> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/nodes/${encodeURIComponent(name)}/uncordon`, {
    method: 'POST',
    headers: token ? { Authorization: token } : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Uncordon failed (${res.status})`);
  }
};

export const drainNode = async (name: string): Promise<void> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/nodes/${encodeURIComponent(name)}/drain`, {
    method: 'POST',
    headers: token ? { Authorization: token } : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Drain failed (${res.status})`);
  }
};

// CRD hooks
export const useCrds = (enabled = true) => {
  return useQuery({
    queryKey: ['crds'],
    queryFn: async () => {
      const res = await apiFetch('/crds');
      if (!res.ok) throw new Error('Failed to fetch CRDs');
      const data = (await res.json()) as ApiResponse<Crd>;
      return data.data;
    },
    staleTime: 1000 * 60 * 5,
    enabled,
  });
};

export const useCustomResources = (crdName: string, namespace?: string) => {
  return useQuery({
    queryKey: ['custom-resources', crdName, namespace],
    queryFn: async () => {
      const params = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
      const res = await apiFetch(`/crds/${encodeURIComponent(crdName)}/resources${params}`);
      if (!res.ok) throw new Error('Failed to fetch custom resources');
      const data = (await res.json()) as ApiResponse<CustomResource>;
      return data.data;
    },
    enabled: Boolean(crdName),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
};

export const deleteCustomResource = (crdName: string, name: string, namespace?: string) => {
  const params = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
  return apiDelete(`/crds/${encodeURIComponent(crdName)}/resources/${encodeURIComponent(name)}${params}`);
};

export const useHelmReleases = () => {
  return useQuery({
    queryKey: ['helm-releases'],
    queryFn: async () => {
      const res = await apiFetch('/helm/releases');
      if (!res.ok) throw new Error('Failed to fetch Helm releases');
      const data = (await res.json()) as ApiResponse<HelmRelease>;
      return data.data;
    },
    refetchInterval: 30_000,
  });
};

export const useHelmCharts = () => {
  return useQuery({
    queryKey: ['helm-charts'],
    queryFn: async () => {
      const res = await apiFetch('/helm/charts');
      if (!res.ok) throw new Error('Failed to fetch Helm charts');
      const data = (await res.json()) as ApiResponse<HelmChart>;
      return data.data;
    },
    staleTime: 10 * 60 * 1000, // cache 10 min — Artifact Hub data changes slowly
  });
};

/** Fetches available versions for a chart (repo_url + chart name). */
export const getHelmChartVersions = async (
  repoUrl: string,
  chart: string,
): Promise<string[]> => {
  const params = new URLSearchParams({ repo_url: repoUrl.trim(), chart: chart.trim() });
  const res = await apiFetch(`/helm/charts/versions?${params.toString()}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: string[] };
  return Array.isArray(json.data) ? json.data : [];
};

export const useHelmChartVersions = (repoUrl: string, chartName: string) => {
  return useQuery({
    queryKey: ['helm-chart-versions', repoUrl, chartName],
    queryFn: () => getHelmChartVersions(repoUrl, chartName),
    enabled: !!repoUrl?.trim() && !!chartName?.trim(),
    staleTime: 5 * 60 * 1000,
  });
};

export const deleteHelmRelease = async (namespace: string, name: string): Promise<void> => {
  const token = getAuthToken();
  const res = await fetch(
    `${API_BASE}/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
    {
      method: 'DELETE',
      headers: token ? { Authorization: token } : undefined,
    },
  );
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text || `Uninstall failed (${res.status})`;
    try {
      const json = JSON.parse(text) as { message?: string };
      if (json.message) msg = json.message;
    } catch {
      /* use msg as-is */
    }
    throw new Error(msg);
  }
};

export const getHelmReleaseYaml = async (namespace: string, name: string): Promise<string> => {
  const token = getAuthToken();
  const res = await fetch(
    `${API_BASE}/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/yaml`,
    { headers: token ? { Authorization: token } : undefined },
  );
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`Failed to load YAML (${res.status})`);
  return res.text();
};

/** Fetches release revision history (helm history -o json). */
export const getHelmReleaseHistory = async (
  namespace: string,
  name: string,
): Promise<HelmRevision[]> => {
  const res = await apiFetch(
    `/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/history`,
  );
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(json.message || `Failed to load history (${res.status})`);
  }
  const json = (await res.json()) as { data?: HelmRevision[] };
  return Array.isArray(json.data) ? json.data : [];
};

export const useHelmReleaseHistory = (namespace: string, name: string) => {
  return useQuery({
    queryKey: ['helm-release-history', namespace, name],
    queryFn: () => getHelmReleaseHistory(namespace, name),
    enabled: !!namespace && !!name,
  });
};

/** Fetches all K8s resources in the release manifest (helm get manifest). */
export const useHelmReleaseResources = (namespace: string, name: string) => {
  return useQuery({
    queryKey: ['helm-release-resources', namespace, name],
    queryFn: async (): Promise<HelmResource[]> => {
      const res = await apiFetch(
        `/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/resources`,
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(json.message || `Failed to load resources (${res.status})`);
      }
      const json = (await res.json()) as { data?: HelmResource[] };
      return Array.isArray(json.data) ? json.data : [];
    },
    enabled: !!namespace && !!name,
  });
};

/** Rollback release to a revision (helm rollback). */
export const rollbackHelmRelease = async (
  namespace: string,
  name: string,
  revision: number,
): Promise<void> => {
  const token = getAuthToken();
  const res = await fetch(
    `${API_BASE}/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/rollback`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: token } : {}),
      },
      body: JSON.stringify({ revision }),
    },
  );
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(json.message || `Rollback failed (${res.status})`);
  }
};

/** Fetches a Helm chart's default values.yaml from the backend (runs helm show values). */
export const getHelmChartValues = async (
  repoUrl: string,
  chart: string,
  version: string,
): Promise<string> => {
  const params = new URLSearchParams({
    repo_url: repoUrl,
    chart,
    version,
  });
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/helm/charts/values?${params.toString()}`, {
    headers: token ? { Authorization: token } : undefined,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Failed to load chart values (${res.status})`);
  }
  return res.text();
};

/** Fetches a Helm chart's README from the backend (runs helm show readme). */
export const getHelmChartReadme = async (
  repoUrl: string,
  chart: string,
  version: string,
): Promise<string> => {
  const params = new URLSearchParams({
    repo_url: repoUrl,
    chart,
    version,
  });
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/helm/charts/readme?${params.toString()}`, {
    headers: token ? { Authorization: token } : undefined,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Failed to load chart README (${res.status})`);
  }
  return res.text();
};

export interface InstallHelmChartParams {
  namespace: string;
  release_name: string;
  repo_url: string;
  chart: string;
  version: string;
  values_yaml: string;
}

export interface InstallHelmChartResult {
  success: boolean;
  message: string;
}

/** Runs helm install via the backend (adds repo, installs chart with values, removes temp repo). */
export const installHelmChart = async (params: InstallHelmChartParams): Promise<InstallHelmChartResult> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/helm/charts/install`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify({
      namespace: params.namespace,
      release_name: params.release_name,
      repo_url: params.repo_url,
      chart: params.chart,
      version: params.version,
      values_yaml: params.values_yaml,
    }),
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  const data = (await res.json()) as InstallHelmChartResult;
  if (!res.ok) {
    throw new Error(data.message || `Install failed (${res.status})`);
  }
  return data;
};

// Port forwarding
export interface PortForward {
  id: number;
  namespace: string;
  resource_type: string;
  resource_name: string;
  local_port: number;
  remote_port: number;
  status: string;
  created_at: string;
}

export interface CreatePortForwardRequest {
  namespace: string;
  resource_type: string;
  resource_name: string;
  local_port: number;
  remote_port: number;
}

export const usePortForwards = () => {
  return useQuery({
    queryKey: ['port-forwards'],
    queryFn: async () => {
      const res = await apiFetch('/port-forwards');
      if (!res.ok) throw new Error('Failed to fetch port forwards');
      const data = (await res.json()) as PortForward[];
      return data;
    },
    refetchInterval: 5000,
  });
};

export const createPortForward = async (request: CreatePortForwardRequest): Promise<PortForward> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/port-forwards`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify(request),
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || `Failed to create port forward (${res.status})`);
  }
  return res.json();
};

export const stopPortForward = async (id: number): Promise<void> => {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/port-forwards/${id}/stop`, {
    method: 'POST',
    headers: token ? { Authorization: token } : undefined,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`Failed to stop port forward (${res.status})`);
};

export const deletePortForward = async (id: number): Promise<void> => {
  await apiDelete(`/port-forwards/${id}`);
};

export const useResourceMap = (namespace: string, options?: { refetchInterval?: number | false }) => {
  return useQuery({
    queryKey: ['resource-map', namespace],
    queryFn: async () => {
      const params = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
      const res = await apiFetch(`/resource-map${params}`);
      if (!res.ok) throw new Error(`Failed to fetch resource map (${res.status})`);
      return res.json() as Promise<ResourceMapData>;
    },
    staleTime: 30_000,
    refetchInterval: options?.refetchInterval,
  });
};
