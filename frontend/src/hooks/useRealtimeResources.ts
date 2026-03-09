import { useEffect, useState } from 'react';
import {
  Namespace,
  Deployment,
  StatefulSet,
  DaemonSet,
  ReplicaSet,
  Job,
  CronJob,
  KubernetesEvent,
  K8sNode,
  Service,
  ConfigMap,
  Secret,
  ResourceQuota,
  LimitRange,
  HPA,
  PDB,
  Endpoint,
  Ingress,
  IngressClass,
  NetworkPolicy,
  PersistentVolume,
  PersistentVolumeClaim,
  StorageClass,
  ServiceAccount,
  ClusterRole,
  ClusterRoleBinding,
  Role,
  RoleBinding,
  PriorityClass,
  RuntimeClass,
  Lease,
  Mwc,
  Vwc,
  CustomResource,
  Crd,
} from '../types';
import { openRealtimeConnection } from '../transport/realtimeTransport';

interface WebSocketMessage {
  type: string;
  resource?: string;
  action?: string;
  data?: unknown;
  message?: string;
}

/** Show WebSocket debug logs in Vite dev or when running on localhost (e.g. local run with built app). */
const isRealtimeDebug = (): boolean =>
  typeof window !== 'undefined' &&
  (import.meta.env.DEV || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

// Transformation functions to convert raw K8s objects to frontend format
function transformNamespace(raw: any): Namespace {
  const metadata = raw.metadata || {};
  const status = raw.status || {};

  const labelsObj = metadata.labels || {};
  const labels = Object.entries(labelsObj)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');

  return {
    name: metadata.name || '',
    phase: status.phase || 'Unknown',
    labels,
    age: metadata.creationTimestamp || '',
  };
}

function transformDeployment(raw: any): Deployment {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};
  
  const desired = spec.replicas || 1;
  const ready = status.readyReplicas || 0;
  const updated = status.updatedReplicas || 0;
  const available = status.availableReplicas || 0;
  
  const images = spec.template?.spec?.containers
    ?.map((c: any) => c.image)
    .filter((img: string) => img) || [];
  
  const statusText = desired === 0
    ? 'Stopped'
    : updated >= desired && available >= desired
    ? 'Running'
    : updated > 0 || available > 0
    ? 'Progressing'
    : 'Pending';
  
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    status: statusText,
    ready: `${ready}/${desired}`,
    updated,
    available,
    images,
    age: metadata.creationTimestamp || '',
    labels: (metadata.labels as Record<string, string> | undefined) ?? undefined,
    annotations: (metadata.annotations as Record<string, string> | undefined) ?? undefined,
  };
}

function transformStatefulSet(raw: any): StatefulSet {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};
  
  const desired = spec.replicas || 0;
  const ready = status.readyReplicas || 0;
  const current = status.currentReplicas || 0;
  const updated = status.updatedReplicas || 0;
  
  const images = spec.template?.spec?.containers
    ?.map((c: any) => c.image)
    .filter((img: string) => img) || [];
  
  const statusText = desired === 0
    ? 'Stopped'
    : ready >= desired
    ? 'Running'
    : current > 0 || updated > 0
    ? 'Progressing'
    : 'Pending';
  
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    status: statusText,
    ready: `${ready}/${desired}`,
    current,
    updated,
    images,
    age: metadata.creationTimestamp || '',
    labels: (metadata.labels as Record<string, string> | undefined) ?? undefined,
    annotations: (metadata.annotations as Record<string, string> | undefined) ?? undefined,
  };
}

function transformDaemonSet(raw: any): DaemonSet {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};
  
  const desired = status.desiredNumberScheduled || 0;
  const current = status.currentNumberScheduled || 0;
  const ready = status.numberReady || 0;
  const available = status.numberAvailable || 0;
  const updated = status.updatedNumberScheduled || 0;
  
  const images = spec.template?.spec?.containers
    ?.map((c: any) => c.image)
    .filter((img: string) => img) || [];
  
  const statusText = desired === 0
    ? 'Stopped'
    : ready >= desired && available >= desired
    ? 'Running'
    : current > 0
    ? 'Progressing'
    : 'Pending';
  
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    status: statusText,
    desired,
    current,
    ready,
    available,
    updated,
    node_selector: spec.template?.spec?.nodeSelector || {},
    images,
    age: metadata.creationTimestamp || '',
    labels: (metadata.labels as Record<string, string> | undefined) ?? undefined,
    annotations: (metadata.annotations as Record<string, string> | undefined) ?? undefined,
  };
}

function transformReplicaSet(raw: any): ReplicaSet {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};
  
  const desired = spec.replicas || 0;
  const current = status.replicas || 0;
  const ready = status.readyReplicas || 0;
  const available = status.availableReplicas || 0;
  
  const images = spec.template?.spec?.containers
    ?.map((c: any) => c.image)
    .filter((img: string) => img) || [];
  
  const statusText = desired === 0
    ? 'Stopped'
    : ready >= desired && available >= desired
    ? 'Running'
    : current > 0 || ready > 0
    ? 'Progressing'
    : 'Pending';
  
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    status: statusText,
    desired,
    current,
    ready,
    available,
    images,
    age: metadata.creationTimestamp || '',
    labels: (metadata.labels as Record<string, string> | undefined) ?? undefined,
    annotations: (metadata.annotations as Record<string, string> | undefined) ?? undefined,
  };
}

function transformJob(raw: any): Job {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};
  
  const completions = spec.completions || 1;
  const succeeded = status.succeeded || 0;
  const failed = status.failed || 0;
  const active = status.active || 0;
  
  let statusText = 'Pending';
  if (succeeded >= completions) {
    statusText = 'Complete';
  } else if (failed > 0) {
    statusText = 'Failed';
  } else if (active > 0) {
    statusText = 'Running';
  }
  
  // Calculate duration
  let duration = '-';
  if (status.startTime) {
    const start = new Date(status.startTime).getTime();
    const end = status.completionTime
      ? new Date(status.completionTime).getTime()
      : Date.now();
    const seconds = Math.floor((end - start) / 1000);
    
    if (seconds < 60) duration = `${seconds}s`;
    else if (seconds < 3600) duration = `${Math.floor(seconds / 60)}m`;
    else if (seconds < 86400) duration = `${Math.floor(seconds / 3600)}h`;
    else duration = `${Math.floor(seconds / 86400)}d`;
  }
  
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    status: statusText,
    completions: `${succeeded}/${completions}`,
    duration,
    age: metadata.creationTimestamp || '',
    labels: (metadata.labels as Record<string, string> | undefined) ?? undefined,
    annotations: (metadata.annotations as Record<string, string> | undefined) ?? undefined,
  };
}

function transformCronJob(raw: any): CronJob {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};
  
  const schedule = spec.schedule || '';
  const suspend = spec.suspend || false;
  const active = status.active?.length || 0;
  const lastSchedule = status.lastScheduleTime || '-';
  
  // Estimate next execution (simplified)
  let nextExecution = '-';
  if (!suspend && lastSchedule !== '-') {
    // This is a simplified estimation - actual cron parsing would be more complex
    nextExecution = 'Calculating...';
  }
  
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    schedule,
    suspend,
    active,
    last_schedule: lastSchedule,
    next_execution: nextExecution,
    time_zone: spec.timeZone || 'UTC',
    age: metadata.creationTimestamp || '',
    labels: (metadata.labels as Record<string, string> | undefined) ?? undefined,
    annotations: (metadata.annotations as Record<string, string> | undefined) ?? undefined,
  };
}

function transformEvent(raw: any): KubernetesEvent {
  const metadata = raw.metadata || {};
  const involvedObject = raw.involvedObject || {};
  
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    involved_object: `${involvedObject.kind || ''}/${involvedObject.name || ''}`,
    reason: raw.reason || '',
    message: raw.message || '',
    count: raw.count || 1,
    first_timestamp: raw.firstTimestamp || metadata.creationTimestamp || '',
    last_timestamp: raw.lastTimestamp || raw.eventTime || metadata.creationTimestamp || '',
    type: raw.type || 'Normal',
  };
}

function transformNode(raw: any): K8sNode {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};
  const conditions = status.conditions || [];
  const readyCondition = conditions.find((c: any) => c.type === 'Ready');
  const ready = readyCondition ? readyCondition.status === 'True' : false;
  const addresses = status.addresses || [];
  const internalIp = addresses.find((a: any) => a.type === 'InternalIP')?.address;
  const externalIp = addresses.find((a: any) => a.type === 'ExternalIP')?.address;
  const ipv4 = addresses
    .filter((a: any) => a.type === 'InternalIP' || a.type === 'ExternalIP')
    .map((a: any) => a.address)
    .find((addr: string) => addr?.includes('.'));
  const ipv6 = addresses
    .filter((a: any) => a.type === 'InternalIP' || a.type === 'ExternalIP')
    .map((a: any) => a.address)
    .find((addr: string) => addr?.includes(':'));
  const nodeInfo = status.nodeInfo || {};
  const labels = metadata.labels || {};
  const roles = Object.keys(labels)
    .filter((key) => key.startsWith('node-role.kubernetes.io/'))
    .map((key) => key.replace('node-role.kubernetes.io/', '') || 'node');
  if (roles.length === 0 && labels['kubernetes.io/role']) roles.push(String(labels['kubernetes.io/role']));
  if (roles.length === 0) roles.push('worker');
  const taints = (spec.taints || []).map(
    (t: any) => (t.value != null ? `${t.key}=${t.value}:${t.effect}` : `${t.key}:${t.effect}`)
  );
  const age = metadata.creationTimestamp
    ? new Date(metadata.creationTimestamp).toISOString()
    : '';

  const allocatable = status.allocatable || status.capacity || {};
  const q = (v: any) => (typeof v === 'string' ? v : v?.string ?? undefined);
  const cpu = q(allocatable.cpu ?? allocatable['cpu']);
  const memory = q(allocatable.memory ?? allocatable['memory']);
  const ephemeral_storage = q(allocatable['ephemeral-storage'] ?? allocatable.ephemeral_storage);
  const pods = q(allocatable.pods ?? allocatable['pods']);

  return {
    name: metadata.name || '',
    ready,
    roles: [...new Set(roles)].sort(),
    ip: ipv4 || internalIp || externalIp || ipv6,
    ipv4: ipv4 || undefined,
    ipv6: ipv6 || undefined,
    internal_ip: internalIp,
    external_ip: externalIp,
    taints,
    labels: Object.keys(labels).length ? (labels as Record<string, string>) : undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
    runtime: nodeInfo.containerRuntimeVersion,
    architecture: nodeInfo.architecture,
    operating_system: nodeInfo.operatingSystem,
    kernel_version: nodeInfo.kernelVersion,
    kubelet_version: nodeInfo.kubeletVersion || '',
    os_image: nodeInfo.osImage || '',
    age,
    unschedulable: spec.unschedulable === true,
    cpu: cpu || undefined,
    memory: memory || undefined,
    ephemeral_storage: ephemeral_storage || undefined,
    pods: pods || undefined,
  };
}

function transformService(raw: any): Service {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};
  const serviceType = spec.type_ ?? spec.type ?? 'ClusterIP';
  const clusterIp = spec.clusterIP ?? spec.cluster_ip ?? '-';
  const externalIps = spec.externalIPs || spec.external_ips || [];
  const lbIngress = status.loadBalancer?.ingress || [];
  const externalValues = [
    ...externalIps,
    ...lbIngress.map((e: any) => e.ip || e.hostname || '-'),
  ].filter((v: string) => v && v !== '-');
  const externalIp = externalValues.length ? externalValues.join(', ') : '-';
  const ports = (spec.ports || [])
    .map((p: any) => `${p.port}/${p.protocol || 'TCP'}`)
    .join(', ');
  const age = metadata.creationTimestamp
    ? new Date(metadata.creationTimestamp).toISOString()
    : '';
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    service_type: serviceType,
    cluster_ip: clusterIp,
    external_ip: externalIp,
    ports: ports || '-',
    age,
    labels: (metadata.labels as Record<string, string> | undefined),
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformConfigMap(raw: any): ConfigMap {
  const metadata = raw.metadata || {};
  const data = raw.data || {};
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    data_keys: Object.keys(data).length,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformSecret(raw: any): Secret {
  const metadata = raw.metadata || {};
  const data = raw.data || {};
  const type = raw.type || 'Opaque';
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    secret_type: type,
    data_keys: Object.keys(data).length,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformResourceQuota(raw: any): ResourceQuota {
  const metadata = raw.metadata || {};
  const status = raw.status || {};
  const hard = status.hard || {};
  const used = status.used || {};
  const statusStr = Object.keys(hard).length > 0
    ? Object.keys(hard).map((k) => `${k}: ${used[k] || '0'}/${hard[k]}`).join(', ')
    : 'None';
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    status: statusStr,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformLimitRange(raw: any): LimitRange {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const limits = spec.limits || [];
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    limits: limits.length,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformHPA(raw: any): HPA {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};
  const ref = spec.scaleTargetRef ? `${spec.scaleTargetRef.kind}/${spec.scaleTargetRef.name}` : '-';
  const targets = status.currentMetrics?.length ?? 0;
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    reference: ref,
    targets,
    current_replicas: status.currentReplicas ?? 0,
    desired_replicas: status.desiredReplicas ?? spec.minReplicas ?? 0,
    min_replicas: spec.minReplicas ?? 0,
    max_replicas: spec.maxReplicas ?? 0,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformPDB(raw: any): PDB {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};
  const minAvail = spec.minAvailable ?? spec.maxUnavailable ?? '-';
  const allowed = status.disruptionsAllowed ?? 0;
  const statusStr = status.currentHealthy !== undefined
    ? `Healthy: ${status.currentHealthy ?? 0}, Desired: ${status.desiredHealthy ?? 0}`
    : 'Unknown';
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    min_available: String(minAvail),
    allowed_disruptions: allowed,
    status: statusStr,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformIngress(raw: any): Ingress {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};
  const rules = spec.rules || [];
  const hosts = rules.map((r: any) => r.host).filter(Boolean).join(', ') || '-';
  const address = (status.loadBalancer?.ingress || []).map((i: any) => i.ip || i.hostname).filter(Boolean).join(', ') || '-';
  const ingressClass = spec.ingressClassName || spec.ingressClass || '-';
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    ingress_class: ingressClass,
    hosts,
    address,
    rules: rules.length,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformIngressClass(raw: any): IngressClass {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const controller = spec.controller || '-';
  const isDefault = metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true';
  const params = spec.parameters ? `${spec.parameters.kind}/${spec.parameters.name}` : '-';
  return {
    name: metadata.name || '',
    controller,
    is_default: isDefault,
    parameters: params,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformEndpoint(raw: any): Endpoint {
  const metadata = raw.metadata || {};
  const subsets = raw.subsets || [];
  let addresses = 0;
  let notReady = 0;
  const portStrs: string[] = [];
  subsets.forEach((s: any) => {
    addresses += (s.addresses || []).length;
    notReady += (s.notReadyAddresses || []).length;
    (s.ports || []).forEach((p: any) => portStrs.push(`${p.port}/${p.protocol || 'TCP'}`));
  });
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    addresses,
    not_ready: notReady,
    ports: [...new Set(portStrs)].join(', ') || '-',
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformNetworkPolicy(raw: any): NetworkPolicy {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const podSelector = spec.podSelector?.matchLabels ? Object.entries(spec.podSelector.matchLabels).map(([k, v]) => `${k}=${v}`).join(', ') : '-';
  const policyTypes = (spec.policyTypes || []).join(', ') || 'Ingress, Egress';
  const ingressRules = (spec.ingress || []).length;
  const egressRules = (spec.egress || []).length;
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    pod_selector: podSelector,
    policy_types: policyTypes,
    ingress_rules: ingressRules,
    egress_rules: egressRules,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformPersistentVolume(raw: any): PersistentVolume {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};
  const capacity = spec.capacity?.storage ?? '-';
  const accessModes = (spec.accessModes || []).join(', ') || '-';
  const reclaimPolicy = spec.persistentVolumeReclaimPolicy || 'Retain';
  const claim = spec.claimRef ? `${spec.claimRef.namespace}/${spec.claimRef.name}` : '-';
  const storageClass = spec.storageClassName || '-';
  return {
    name: metadata.name || '',
    capacity: capacity,
    access_modes: accessModes,
    reclaim_policy: reclaimPolicy,
    status: status.phase || 'Unknown',
    claim,
    storage_class: storageClass,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformPersistentVolumeClaim(raw: any): PersistentVolumeClaim {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};
  const volume = spec.volumeName || '-';
  const capacity = status.capacity?.storage ?? '-';
  const accessModes = (spec.accessModes || []).join(', ') || '-';
  const storageClass = spec.storageClassName || '-';
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    status: status.phase || 'Unknown',
    volume,
    capacity,
    access_modes: accessModes,
    storage_class: storageClass,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformStorageClass(raw: any): StorageClass {
  const metadata = raw.metadata || {};
  const provisioner = raw.provisioner || '-';
  const reclaimPolicy = raw.reclaimPolicy || 'Delete';
  const volumeBindingMode = raw.volumeBindingMode || 'Immediate';
  const allowExpand = raw.allowVolumeExpansion === true;
  const isDefault = metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true';
  return {
    name: metadata.name || '',
    provisioner,
    reclaim_policy: reclaimPolicy,
    volume_binding_mode: volumeBindingMode,
    allow_volume_expansion: allowExpand,
    is_default: isDefault,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformServiceAccount(raw: any): ServiceAccount {
  const metadata = raw.metadata || {};
  const secrets = raw.secrets || [];
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    secrets: secrets.length,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformClusterRole(raw: any): ClusterRole {
  const metadata = raw.metadata || {};
  const rules = raw.rules || [];
  return {
    name: metadata.name || '',
    rules: rules.length,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformClusterRoleBinding(raw: any): ClusterRoleBinding {
  const metadata = raw.metadata || {};
  const roleRef = raw.roleRef || {};
  const subjects = raw.subjects || [];
  const role = roleRef.name ? `${roleRef.kind}/${roleRef.name}` : '-';
  return {
    name: metadata.name || '',
    role,
    subjects: subjects.length,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformRole(raw: any): Role {
  const metadata = raw.metadata || {};
  const rules = raw.rules || [];
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    rules: rules.length,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformRoleBinding(raw: any): RoleBinding {
  const metadata = raw.metadata || {};
  const roleRef = raw.roleRef || {};
  const subjects = raw.subjects || [];
  const role = roleRef.name ? `${roleRef.kind}/${roleRef.name}` : '-';
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    role,
    subjects: subjects.length,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformPriorityClass(raw: any): PriorityClass {
  const metadata = raw.metadata || {};
  const value = raw.value ?? 0;
  const globalDefault = raw.globalDefault === true;
  return {
    name: metadata.name || '',
    value,
    global_default: globalDefault,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformRuntimeClass(raw: any): RuntimeClass {
  const metadata = raw.metadata || {};
  const handler = raw.handler || '-';
  const scheduling = raw.scheduling?.nodeSelector ? JSON.stringify(raw.scheduling.nodeSelector) : '-';
  return {
    name: metadata.name || '',
    handler,
    scheduling,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformLease(raw: any): Lease {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const holder = spec.holderIdentity ?? '-';
  const duration = spec.leaseDurationSeconds ?? 0;
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    holder_identity: holder,
    lease_duration_seconds: duration,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function normalizeRawData(raw: any): any {
  return raw?.data ?? raw;
}

function transformMwc(raw: any): Mwc {
  const d = normalizeRawData(raw);
  const metadata = d?.metadata || {};
  const webhooks = d?.webhooks || [];
  return {
    name: metadata.name || '',
    webhooks_count: Array.isArray(webhooks) ? webhooks.length : 0,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformVwc(raw: any): Vwc {
  const d = normalizeRawData(raw);
  const metadata = d?.metadata || {};
  const webhooks = d?.webhooks || [];
  return {
    name: metadata.name || '',
    webhooks_count: Array.isArray(webhooks) ? webhooks.length : 0,
    age: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : '',
    labels: metadata.labels as Record<string, string> | undefined,
    annotations: metadata.annotations as Record<string, string> | undefined,
  };
}

function transformCustomResource(raw: any): CustomResource {
  const metadata = raw.metadata || {};
  const name = metadata.name || '';
  const namespace = metadata.namespace ?? null;
  const created_at = metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : null;
  const spec = (raw.data && raw.data.spec) ? raw.data.spec : (raw.spec || {});
  const status = (raw.data && raw.data.status) != null ? raw.data.status : (raw.status != null ? raw.status : null);
  const labels = (metadata.labels as Record<string, string> | undefined) ?? undefined;
  const annotations = (metadata.annotations as Record<string, string> | undefined) ?? undefined;
  return { name, namespace, created_at, spec, status, labels, annotations };
}

function transformCrd(raw: any): Crd {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const names = spec.names || {};
  const versionsList = spec.versions || [];
  const versions = versionsList.map((v: any) => ({
    name: v.name || '',
    served: v.served === true,
    storage: v.storage === true,
  }));
  // Preferred version = storage version; get additionalPrinterColumns (v1) or additional_printer_columns (Rust/snake)
  const preferred = versionsList.find((v: any) => v.storage === true) || versionsList[0];
  const additionalPrinterColumns =
    preferred?.additionalPrinterColumns ?? preferred?.additional_printer_columns ?? [];
  const printer_columns: { name: string; jsonPath: string; type?: string; priority?: number }[] =
    additionalPrinterColumns
      .filter((col: any) => col && (col.name || col.jsonPath || col.json_path))
      .map((col: any) => ({
        name: col.name ?? '',
        jsonPath: col.jsonPath ?? col.json_path ?? '',
        type: col.type,
        priority: col.priority,
      }))
      .filter((c: { name: string; jsonPath: string }) => c.jsonPath && c.name.toLowerCase() !== 'age');

  return {
    name: metadata.name || '',
    group: spec.group || '',
    scope: spec.scope || 'Namespaced',
    kind: names.kind || '',
    singular: names.singular || names.kind || '',
    plural: names.plural || '',
    short_names: names.short_names || [],
    versions,
    printer_columns: printer_columns.length > 0 ? printer_columns : undefined,
    created_at: metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toISOString() : null,
  };
}

// Generic hook factory for realtime resources
function createRealtimeHook<T>(
  resourceType: string,
  displayName: string,
  transformFn: (raw: any) => T,
  getKey: (item: T) => string
) {
  return function useRealtimeResource(): {
    data: T[];
    isLoading: boolean;
    error: string | null;
  } {
    const [data, setData] = useState<T[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      let closeConnection: (() => void) | null = null;
      let reconnectTimeout: ReturnType<typeof setTimeout>;

      const connect = () => {
        try {
          closeConnection = openRealtimeConnection(resourceType, {
            onOpen: () => {
              if (isRealtimeDebug()) console.log(`Realtime connected for ${displayName}`);
              setError(null);
              setIsLoading(false);
            },
            onMessage: (message: Record<string, unknown>) => {
              const msg = message as unknown as WebSocketMessage;
              if (msg.type === 'resource_update' && msg.resource === resourceType) {
                const action = (msg.action as string)?.toUpperCase();
                const rawItem = msg.data;

                if (!rawItem) return;

                const item = transformFn(rawItem);

                if (action === 'ADDED' || action === 'MODIFIED') {
                  setData((prev) => {
                    const itemKey = getKey(item);
                    const existingIndex = prev.findIndex((p) => getKey(p) === itemKey);

                    if (existingIndex >= 0) {
                      const updated = [...prev];
                      updated[existingIndex] = item;
                      return updated;
                    }
                    return [...prev, item];
                  });
                } else if (action === 'DELETED') {
                  const itemKey = getKey(item);
                  setData((prev) => prev.filter((p) => getKey(p) !== itemKey));
                }
              } else if (msg.type === 'subscribed' && msg.resource === resourceType) {
                if (isRealtimeDebug()) console.log(`Subscribed to ${displayName}`);
              } else if (msg.type === 'error') {
                console.error(`Realtime error for ${displayName}:`, msg.message);
                setError((msg.message as string) || 'Unknown error');
              }
            },
            onError: (event) => {
              console.error(`Realtime error for ${displayName}:`, event);
              setError(`Connection error for ${displayName}`);
            },
            onClose: () => {
              if (isRealtimeDebug()) console.log(`Realtime disconnected for ${displayName}`);
              closeConnection = null;
              reconnectTimeout = setTimeout(() => {
                if (isRealtimeDebug()) console.log(`Attempting to reconnect to ${displayName}...`);
                connect();
              }, 3000);
            },
          });
        } catch (err) {
          console.error(`Failed to connect realtime for ${displayName}:`, err);
          setError(`Failed to connect to ${displayName} stream`);
          reconnectTimeout = setTimeout(connect, 3000);
        }
      };

      connect();

      return () => {
        clearTimeout(reconnectTimeout);
        closeConnection?.();
      };
    }, []);

    return { data, isLoading, error };
  };
}

// Create hooks for each resource type
export const useRealtimeNamespaces = createRealtimeHook<Namespace>(
  'namespaces',
  'Namespaces',
  transformNamespace,
  (item) => item.name
);
export const useRealtimeDeployments = createRealtimeHook<Deployment>(
  'deployments',
  'Deployments',
  transformDeployment,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeStatefulSets = createRealtimeHook<StatefulSet>(
  'statefulsets',
  'StatefulSets',
  transformStatefulSet,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeDaemonSets = createRealtimeHook<DaemonSet>(
  'daemonsets',
  'DaemonSets',
  transformDaemonSet,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeReplicaSets = createRealtimeHook<ReplicaSet>(
  'replicasets',
  'ReplicaSets',
  transformReplicaSet,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeJobs = createRealtimeHook<Job>(
  'jobs',
  'Jobs',
  transformJob,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeCronJobs = createRealtimeHook<CronJob>(
  'cronjobs',
  'CronJobs',
  transformCronJob,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeEvents = createRealtimeHook<KubernetesEvent>(
  'events',
  'Events',
  transformEvent,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeNodes = createRealtimeHook<K8sNode>(
  'nodes',
  'Nodes',
  transformNode,
  (item) => item.name
);
export const useRealtimeServices = createRealtimeHook<Service>(
  'services',
  'Services',
  transformService,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeConfigMaps = createRealtimeHook<ConfigMap>(
  'configmaps',
  'ConfigMaps',
  transformConfigMap,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeSecrets = createRealtimeHook<Secret>(
  'secrets',
  'Secrets',
  transformSecret,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeResourceQuotas = createRealtimeHook<ResourceQuota>(
  'resourcequotas',
  'ResourceQuotas',
  transformResourceQuota,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeLimitRanges = createRealtimeHook<LimitRange>(
  'limitranges',
  'LimitRanges',
  transformLimitRange,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeHPA = createRealtimeHook<HPA>(
  'hpa',
  'HPA',
  transformHPA,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimePDB = createRealtimeHook<PDB>(
  'pdb',
  'PDB',
  transformPDB,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeIngresses = createRealtimeHook<Ingress>(
  'ingresses',
  'Ingresses',
  transformIngress,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeIngressClasses = createRealtimeHook<IngressClass>(
  'ingressclasses',
  'IngressClasses',
  transformIngressClass,
  (item) => item.name
);
export const useRealtimeEndpoints = createRealtimeHook<Endpoint>(
  'endpoints',
  'Endpoints',
  transformEndpoint,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeNetworkPolicies = createRealtimeHook<NetworkPolicy>(
  'networkpolicies',
  'NetworkPolicies',
  transformNetworkPolicy,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimePersistentVolumes = createRealtimeHook<PersistentVolume>(
  'persistentvolumes',
  'PersistentVolumes',
  transformPersistentVolume,
  (item) => item.name
);
export const useRealtimePersistentVolumeClaims = createRealtimeHook<PersistentVolumeClaim>(
  'persistentvolumeclaims',
  'PersistentVolumeClaims',
  transformPersistentVolumeClaim,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeStorageClasses = createRealtimeHook<StorageClass>(
  'storageclasses',
  'StorageClasses',
  transformStorageClass,
  (item) => item.name
);
export const useRealtimeServiceAccounts = createRealtimeHook<ServiceAccount>(
  'serviceaccounts',
  'ServiceAccounts',
  transformServiceAccount,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeClusterRoles = createRealtimeHook<ClusterRole>(
  'clusterroles',
  'ClusterRoles',
  transformClusterRole,
  (item) => item.name
);
export const useRealtimeClusterRoleBindings = createRealtimeHook<ClusterRoleBinding>(
  'clusterrolebindings',
  'ClusterRoleBindings',
  transformClusterRoleBinding,
  (item) => item.name
);
export const useRealtimeRoles = createRealtimeHook<Role>(
  'roles',
  'Roles',
  transformRole,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeRoleBindings = createRealtimeHook<RoleBinding>(
  'rolebindings',
  'RoleBindings',
  transformRoleBinding,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimePriorityClasses = createRealtimeHook<PriorityClass>(
  'priorityclasses',
  'PriorityClasses',
  transformPriorityClass,
  (item) => item.name
);
export const useRealtimeRuntimeClasses = createRealtimeHook<RuntimeClass>(
  'runtimeclasses',
  'RuntimeClasses',
  transformRuntimeClass,
  (item) => item.name
);
export const useRealtimeLeases = createRealtimeHook<Lease>(
  'leases',
  'Leases',
  transformLease,
  (item) => `${item.namespace}/${item.name}`
);
export const useRealtimeMwcs = createRealtimeHook<Mwc>(
  'mwc',
  'MWC',
  transformMwc,
  (item) => item.name
);
export const useRealtimeVwcs = createRealtimeHook<Vwc>(
  'vwc',
  'VWC',
  transformVwc,
  (item) => item.name
);
export const useRealtimeCrds = createRealtimeHook<Crd>(
  'crds',
  'CRDs',
  transformCrd,
  (item) => item.name
);

function getCustomResourceKey(item: CustomResource): string {
  return item.namespace ? `${item.namespace}/${item.name}` : item.name;
}

/** Realtime list for a custom resource kind by CRD name (e.g. "crontabs.stable.example.com"). */
export function useRealtimeCustomResources(crdName: string | null): {
  data: CustomResource[];
  isLoading: boolean;
  error: string | null;
} {
  const [data, setData] = useState<CustomResource[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const resourceType = crdName ? `customresources/${crdName}` : '';

  useEffect(() => {
    if (!crdName || !resourceType) {
      setData([]);
      setIsLoading(false);
      return;
    }
    let closeConnection: (() => void) | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    const connect = () => {
      try {
        closeConnection = openRealtimeConnection(resourceType, {
          onOpen: () => {
            setError(null);
            setIsLoading(false);
          },
          onMessage: (message: Record<string, unknown>) => {
            const msg = message as unknown as WebSocketMessage;
            if (msg.type === 'resource_update' && msg.resource === resourceType && msg.data) {
              const action = ((msg.action as string) || '').toUpperCase();
              const item = transformCustomResource(msg.data);
              const itemKey = getCustomResourceKey(item);
              if (action === 'ADDED' || action === 'MODIFIED') {
                setData((prev) => {
                  const idx = prev.findIndex((p) => getCustomResourceKey(p) === itemKey);
                  if (idx >= 0) {
                    const next = [...prev];
                    next[idx] = item;
                    return next;
                  }
                  return [...prev, item];
                });
              } else if (action === 'DELETED') {
                setData((prev) => prev.filter((p) => getCustomResourceKey(p) !== itemKey));
              }
            } else if (msg.type === 'error') {
              setError((msg.message as string) || 'Unknown error');
            }
          },
          onError: () => setError('Connection error'),
          onClose: () => {
            closeConnection = null;
            reconnectTimeout = setTimeout(connect, 3000);
          },
        });
      } catch (err) {
        setError('Failed to connect');
        reconnectTimeout = setTimeout(connect, 3000);
      }
    };
    connect();
    return () => {
      clearTimeout(reconnectTimeout);
      closeConnection?.();
    };
  }, [crdName, resourceType]);

  return { data, isLoading, error };
}
