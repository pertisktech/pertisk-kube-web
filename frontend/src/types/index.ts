// Kubernetes resource types
export interface CrdVersion {
  name: string;
  served: boolean;
  storage: boolean;
}

export interface HelmRelease {
  name: string;
  namespace: string;
  chart: string;
  revision: number;
  chart_version: string;
  app_version: string;
  status: string;
  updated: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

/** Single revision entry from helm history. */
export interface HelmRevision {
  revision: number;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
  description: string;
}

/** A single K8s resource belonging to a Helm release manifest. */
export interface HelmResource {
  api_version: string;
  kind: string;
  name: string;
  namespace: string;
}

export interface HelmChart {
  name: string;
  description: string;
  version: string;
  app_version: string;
  repository: string;
  repository_url: string;
  stars: number;
}

/** Printer column from CRD additionalPrinterColumns (for table and detail panel) */
export interface CrdPrinterColumn {
  name: string;
  jsonPath: string;
  type?: string;
  priority?: number;
}

export interface Crd {
  name: string;
  group: string;
  scope: string;
  kind: string;
  singular: string;
  plural: string;
  short_names: string[];
  versions: CrdVersion[];
  /** Columns from CRD preferred version (for table and detail) */
  printer_columns?: CrdPrinterColumn[];
  created_at: string | null;
}

export interface CustomResource {
  name: string;
  namespace: string | null;
  created_at: string | null;
  spec: Record<string, unknown>;
  status: Record<string, unknown> | null;
  labels?: Record<string, string> | null;
  annotations?: Record<string, string> | null;
  manifest?: Record<string, unknown> | null;
}

export interface Namespace {
  name: string;
  phase: string;
  labels: string;
  age: string;
}

export interface Pod {
  name: string;
  namespace: string;
  created?: string;
  status?: string;
  display_status?: string;
  phase?: string;
  last_error?: string;
  ready: string;
  restarts: number;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  node?: string;
  pod_ip?: string;
  pod_ips?: string[];
  service_account?: string;
  cpu?: string;
  memory?: string;
  cpu_capacity?: string;
  memory_capacity?: string;
  cpu_usage_percent?: number;
  memory_usage_percent?: number;
  controlled_by?: string;
  qos?: string;
  qos_class?: string;
  conditions?: Array<{
    type: string;
    status: string;
    reason?: string;
    last_transition_time?: string;
  }>;
  tolerations?: Array<{
    key: string;
    operator: string;
    effect: string;
    seconds: string;
    value?: string;
  }>;
  pod_anti_affinities?: string[];
  volumes?: Array<{
    name: string;
    type?: string;
    source?: string;
    read_only?: boolean;
  }>;
  containers?: Array<{
    name: string;
    image?: string;
    ready?: boolean;
    restart_count?: number;
    state?: string;
    status?: string;
    image_pull_policy?: string;
    ports?: string[];
    environment_variables?: Array<{ key: string; value?: string; decoded_value?: string; source?: string }>;
    mounts?: string[];
    liveness?: string;
    readiness?: string;
    startup?: string;
    requests?: string;
    limits?: string;
  }>;
  events?: Array<{
    type?: string;
    reason?: string;
    message?: string;
    count?: number;
    age?: string;
  }>;
}

export interface Deployment {
  name: string;
  namespace: string;
  status: string;
  ready: string;
  updated: number;
  available: number;
  age: string;
  images: string[];
  selector_labels?: Record<string, string>;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface StatefulSet {
  name: string;
  namespace: string;
  status: string;
  ready: string;
  current: number;
  updated: number;
  age: string;
  images: string[];
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface DaemonSet {
  name: string;
  namespace: string;
  status: string;
  desired: number;
  current: number;
  ready: number;
  available: number;
  updated: number;
  node_selector: Record<string, string>;
  age: string;
  images: string[];
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface ReplicaSet {
  name: string;
  namespace: string;
  status: string;
  desired: number;
  current: number;
  ready: number;
  available: number;
  age: string;
  images: string[];
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface Job {
  name: string;
  namespace: string;
  status?: string;
  completions: string;
  duration: string;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface CronJob {
  name: string;
  namespace: string;
  schedule: string;
  suspend: boolean;
  active: number;
  last_schedule: string;
  next_execution: string;
  time_zone: string;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface KubernetesEvent {
  name: string;
  namespace: string;
  involved_object: string;
  reason: string;
  message: string;
  count: number;
  first_timestamp: string;
  last_timestamp: string;
  type: string;
}

export interface K8sNode {
  name: string;
  ready: boolean | string;
  conditions?: Array<{
    type: string;
    status: string;
    reason?: string;
    message?: string;
    last_transition_time?: string;
  }>;
  roles: string[];
  ip?: string;
  ipv4?: string;
  ipv6?: string;
  internal_ip?: string;
  external_ip?: string;
  taints?: string[];
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  runtime?: string;
  architecture?: string;
  operating_system?: string;
  kernel_version?: string;
  kubelet_version: string;
  os_image: string;
  age?: string;
  cpu?: string;
  memory?: string;
  ephemeral_storage?: string;
  pods?: string;
  cpu_used?: string;
  memory_used?: string;
  ephemeral_storage_used?: string;
  cpu_usage_percent?: number;
  memory_usage_percent?: number;
  ephemeral_storage_usage_percent?: number;
  unschedulable?: boolean;
}

export interface DashboardSummary {
  namespaces: number;
  pods: number;
  deployments: number;
  statefulsets: number;
  daemonsets: number;
  replicasets: number;
  jobs: number;
  cronjobs: number;
  events: number;
  cluster_name?: string;
  api_endpoint?: string;
  kube_version?: string;
}

export interface NodeGroup {
  name: string;
  node_count: number;
  ready_count: number;
  roles: string[];
}

export interface ApiResponse<T> {
  data: T[];
  total: number;
}

export interface BackupSettings {
  schedule_name: string;
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
  schedule_enabled: boolean;
  schedule_cron: string;
  ttl: string;
  include_namespaces: string[];
  exclude_namespaces: string[];
}

export interface BackupRecord {
  name: string;
  phase: string;
  storage_location: string;
  created_at: string;
  size_bytes?: number | null;
  include_namespaces: string[];
  exclude_namespaces: string[];
  resource_summary: string;
  kind_summary: Record<string, number>;
}

export interface ScheduleRecord {
  name: string;
  cron: string;
  timezone: string;
  last_backup: string;
  paused: boolean;
  include_namespaces: string[];
  exclude_namespaces: string[];
}

export interface RestoreRecord {
  name: string;
  backup_name: string;
  phase: string;
  created_at: string;
}

export interface BackupOverview {
  backups: BackupRecord[];
  schedules: ScheduleRecord[];
  restores: RestoreRecord[];
}

// Config Resources
export interface ConfigMap {
  name: string;
  namespace: string;
  data_keys: number;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface Secret {
  name: string;
  namespace: string;
  secret_type: string;
  data_keys: number;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface ResourceQuota {
  name: string;
  namespace: string;
  status: string;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface LimitRange {
  name: string;
  namespace: string;
  limits: number;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface HPA {
  name: string;
  namespace: string;
  reference: string;
  targets: number;
  cpu_target?: string;
  cpu_current?: string;
  memory_target?: string;
  memory_current?: string;
  current_replicas: number;
  desired_replicas: number;
  min_replicas: number;
  max_replicas: number;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface PDB {
  name: string;
  namespace: string;
  min_available: string;
  allowed_disruptions: number;
  status: string;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface PriorityClass {
  name: string;
  value: number;
  global_default: boolean;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface RuntimeClass {
  name: string;
  handler: string;
  scheduling: string;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface Lease {
  name: string;
  namespace: string;
  holder_identity: string;
  lease_duration_seconds: number;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface Mwc {
  name: string;
  webhooks_count: number;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface Vwc {
  name: string;
  webhooks_count: number;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

// Network Resources
export interface Service {
  name: string;
  namespace: string;
  service_type: string;
  cluster_ip: string;
  external_ip: string;
  ports: string;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface Endpoint {
  name: string;
  namespace: string;
  addresses: number;
  not_ready: number;
  ports: string;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface Ingress {
  name: string;
  namespace: string;
  ingress_class: string;
  hosts: string;
  address: string;
  rules: number;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface IngressClass {
  name: string;
  controller: string;
  is_default: boolean;
  parameters: string;
  address?: string;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface NetworkPolicy {
  name: string;
  namespace: string;
  pod_selector: string;
  policy_types: string;
  ingress_rules: number;
  egress_rules: number;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

// Storage Resources
export interface PersistentVolume {
  name: string;
  capacity: string;
  access_modes: string;
  reclaim_policy: string;
  status: string;
  claim: string;
  storage_class: string;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface PersistentVolumeClaim {
  name: string;
  namespace: string;
  status: string;
  volume: string;
  capacity: string;
  access_modes: string;
  storage_class: string;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface StorageClass {
  name: string;
  provisioner: string;
  reclaim_policy: string;
  volume_binding_mode: string;
  allow_volume_expansion: boolean;
  is_default: boolean;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

// Access Control (RBAC) Resources
export interface ServiceAccount {
  name: string;
  namespace: string;
  secrets: number;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface Role {
  name: string;
  namespace: string;
  rules: number;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface RoleBinding {
  name: string;
  namespace: string;
  role: string;
  subjects: number;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface ClusterRole {
  name: string;
  rules: number;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface ClusterRoleBinding {
  name: string;
  role: string;
  subjects: number;
  age: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

// ── Resource Map ────────────────────────────────────────────────────────

export interface ResourceMapNode {
  id: string;
  kind: string;
  name: string;
  namespace?: string;
  status: string;
}

export interface ResourceMapEdge {
  source: string;
  target: string;
  edge_type: string;
}

export interface ResourceMapData {
  nodes: ResourceMapNode[];
  edges: ResourceMapEdge[];
}

export interface MetricSeriesPoint {
  timestamp: number;
  value: number;
}

export interface WorkloadMetricSeriesResponse {
  cpu: MetricSeriesPoint[];
  memory: MetricSeriesPoint[];
  network: MetricSeriesPoint[];
  filesystem: MetricSeriesPoint[];
  network_available: boolean;
  filesystem_available: boolean;
}
