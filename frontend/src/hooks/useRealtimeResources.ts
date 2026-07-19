import { useEffect, useState } from 'react';
import CronExpressionParser from 'cron-parser';
import { sortNodeRoles } from '../utils/nodeRoles';
import {
  applyIngressControllerAddresses,
  refreshIngressClassAddressMap,
  resolveIngressAddressForClass,
} from '../utils/ingress';
import { getAuthToken } from '../utils/auth';
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
  HelmRelease,
} from '../types';

interface WebSocketMessage {
  type: string;
  resource?: string;
  action?: string;
  data?: unknown;
  message?: string;
}

/** Re-fetch realtime resource snapshots (helm releases, pods, etc.). */
export const dispatchResourcesRefresh = () => {
  window.dispatchEvent(new CustomEvent('resources:refresh'));
};

/** Show WebSocket debug logs in Vite dev or when running on localhost (e.g. local run with built app). */
const isRealtimeDebug = (): boolean =>
  typeof window !== 'undefined' &&
  (import.meta.env.DEV || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

const shouldIgnoreRealtimeError = (message?: string): boolean => {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return normalized.includes('watch stream failed') && normalized.includes('forbidden');
};

const isTransientK8sListError = (message?: string): boolean => {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return normalized.includes('toomanyrequests')
    || normalized.includes('storage is (re)initializing')
    || normalized.includes('code: 429')
    || normalized.includes('temporarily unavailable');
};

const isTransientRealtimeConnectivityError = (message?: string): boolean => {
  if (!message) return false;
  if (isTransientK8sListError(message)) return true;
  const normalized = message.toLowerCase();
  return normalized.includes('client error (connect)')
    || normalized.includes('connecterror')
    || normalized.includes('network is unreachable')
    || normalized.includes('timedout')
    || normalized.includes('timed out')
    || normalized.includes('failed to fetch initial')
    || normalized.includes('load failed')
    || normalized.includes('failed to fetch')
    || normalized.includes('could not connect')
    || normalized.includes('networkerror')
    || normalized.includes('network request failed');
};

export const isFetchConnectionError = (error: unknown): boolean => {
  if (error instanceof TypeError) {
    return isTransientRealtimeConnectivityError(error.message);
  }
  if (error instanceof Error) {
    return isTransientRealtimeConnectivityError(error.message);
  }
  if (typeof error === 'string') {
    return isTransientRealtimeConnectivityError(error);
  }
  return false;
};

type RealtimeMessageListener = (message: WebSocketMessage) => void;

const realtimeResourceListeners = new Map<string, Set<RealtimeMessageListener>>();
let realtimeSharedSocket: WebSocket | null = null;
let realtimeSharedReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let realtimeSharedHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let realtimeSharedStaleWatchdogTimer: ReturnType<typeof setInterval> | null = null;
let realtimeSharedLastMessageAt = Date.now();
let realtimeSharedReconnectAttempts = 0;
let realtimeSharedClosingIntentional = false;
let realtimeSharedConnectInFlight = false;

const getRealtimeWsUrl = (): string => (
  `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
);

const clearRealtimeSharedTimers = () => {
  if (realtimeSharedReconnectTimer) {
    clearTimeout(realtimeSharedReconnectTimer);
    realtimeSharedReconnectTimer = null;
  }
  if (realtimeSharedHeartbeatTimer) {
    clearInterval(realtimeSharedHeartbeatTimer);
    realtimeSharedHeartbeatTimer = null;
  }
  if (realtimeSharedStaleWatchdogTimer) {
    clearInterval(realtimeSharedStaleWatchdogTimer);
    realtimeSharedStaleWatchdogTimer = null;
  }
};

const safeCloseRealtimeSocket = (socket: WebSocket) => {
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.onopen = () => {
      socket.close();
    };
    return;
  }

  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
    socket.close();
  }
};

const dispatchRealtimeMessage = (message: WebSocketMessage) => {
  if (message.resource) {
    const listeners = realtimeResourceListeners.get(message.resource);
    if (listeners) {
      listeners.forEach((listener) => {
        listener(message);
      });
    }
    return;
  }

  if (message.type === 'error') {
    realtimeResourceListeners.forEach((listeners) => {
      listeners.forEach((listener) => listener(message));
    });
  }
};

const openRealtimeSharedSocket = () => {
  if (realtimeSharedSocket && (
    realtimeSharedSocket.readyState === WebSocket.OPEN
    || realtimeSharedSocket.readyState === WebSocket.CONNECTING
  )) {
    return;
  }

  if (realtimeSharedConnectInFlight) {
    return;
  }

  if (realtimeResourceListeners.size === 0) {
    return;
  }

  realtimeSharedConnectInFlight = true;

  try {
    const socket = new WebSocket(getRealtimeWsUrl());
    realtimeSharedSocket = socket;

    socket.onopen = () => {
      realtimeSharedConnectInFlight = false;

      if (realtimeSharedClosingIntentional) {
        socket.close();
        return;
      }

      realtimeSharedReconnectAttempts = 0;
      realtimeSharedLastMessageAt = Date.now();

      if (isRealtimeDebug()) {
        console.log('Realtime shared websocket connected');
      }

      clearRealtimeSharedTimers();

      realtimeSharedHeartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping' }));
        }
      }, 15000);

      realtimeSharedStaleWatchdogTimer = setInterval(() => {
        const staleForMs = Date.now() - realtimeSharedLastMessageAt;
        if (socket.readyState === WebSocket.OPEN && staleForMs > 45000) {
          if (isRealtimeDebug()) {
            console.warn(`Realtime shared websocket stale for ${staleForMs}ms; reconnecting`);
          }
          socket.close();
        }
      }, 10000);

      realtimeResourceListeners.forEach((_listeners, resource) => {
        socket.send(JSON.stringify({ type: 'subscribe', resource }));
      });
    };

    socket.onmessage = (event) => {
      realtimeSharedLastMessageAt = Date.now();
      try {
        const message = JSON.parse(event.data) as WebSocketMessage;
        dispatchRealtimeMessage(message);
      } catch (error) {
        console.error('Realtime shared websocket parse error:', error);
      }
    };

    socket.onerror = () => {
      if (realtimeSharedClosingIntentional) return;
      if (import.meta.env.DEV && socket.readyState !== WebSocket.OPEN) return;
      if (isRealtimeDebug()) {
        console.warn('Realtime shared websocket error');
      }
    };

    socket.onclose = () => {
      realtimeSharedConnectInFlight = false;
      clearRealtimeSharedTimers();

      if (realtimeSharedClosingIntentional) {
        realtimeSharedClosingIntentional = false;
        return;
      }

      if (realtimeResourceListeners.size === 0) {
        return;
      }

      realtimeSharedReconnectAttempts += 1;
      const delay = 1200 + Math.min(5000, (realtimeSharedReconnectAttempts - 1) * 700);
      realtimeSharedReconnectTimer = setTimeout(() => {
        if (realtimeResourceListeners.size === 0) {
          return;
        }
        openRealtimeSharedSocket();
      }, delay);
    };
  } catch (error) {
    realtimeSharedConnectInFlight = false;
    if (isRealtimeDebug()) {
      console.error('Failed to create realtime shared websocket:', error);
    }
  }
};

const realtimeSnapshotUrl = (resourceType: string): string => {
  if (resourceType === 'helmreleases') {
    return '/api/helm/releases';
  }
  return `/api/${resourceType}`;
};

const fetchRealtimeResourceSnapshot = async <T>(
  resourceType: string,
  transformFn: (raw: any) => T,
  signal: AbortSignal,
): Promise<T[]> => {
  const token = getAuthToken();
  const response = await fetch(realtimeSnapshotUrl(resourceType), {
    cache: 'no-store',
    signal,
    headers: token ? { Authorization: token } : undefined,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch initial ${resourceType} snapshot`);
  }

  const payload = await response.json() as { data?: any[] };
  const items = Array.isArray(payload?.data) ? payload.data : [];

  let result = items.map((raw) => {
    const looksLikeRawK8sObject =
      raw
      && typeof raw === 'object'
      && raw !== null
      && typeof (raw as { metadata?: unknown }).metadata === 'object'
      && (raw as { metadata?: unknown }).metadata !== null;

    if (looksLikeRawK8sObject) {
      return transformFn(raw);
    }

    // REST list endpoints already return frontend-shaped items; avoid double-transform.
    return raw as T;
  });

  if (resourceType === 'ingresses') {
    const classAddressMap = await refreshIngressClassAddressMap(signal);
    result = applyIngressControllerAddresses(result as Ingress[], classAddressMap) as T[];
  }

  return result;
};

const subscribeRealtimeResource = (
  resource: string,
  listener: RealtimeMessageListener,
): (() => void) => {
  let listeners = realtimeResourceListeners.get(resource);
  const isFirstSubscriberForResource = !listeners;

  if (!listeners) {
    listeners = new Set<RealtimeMessageListener>();
    realtimeResourceListeners.set(resource, listeners);
  }
  listeners.add(listener);

  openRealtimeSharedSocket();

  if (
    isFirstSubscriberForResource
    && realtimeSharedSocket
    && realtimeSharedSocket.readyState === WebSocket.OPEN
  ) {
    realtimeSharedSocket.send(JSON.stringify({ type: 'subscribe', resource }));
  }

  return () => {
    const set = realtimeResourceListeners.get(resource);
    if (!set) return;

    set.delete(listener);

    if (set.size === 0) {
      realtimeResourceListeners.delete(resource);

      if (realtimeSharedSocket && realtimeSharedSocket.readyState === WebSocket.OPEN) {
        realtimeSharedSocket.send(JSON.stringify({ type: 'unsubscribe', resource }));
      }
    }

    if (realtimeResourceListeners.size === 0 && realtimeSharedSocket) {
      realtimeSharedClosingIntentional = true;
      clearRealtimeSharedTimers();
      safeCloseRealtimeSocket(realtimeSharedSocket);
      realtimeSharedSocket = null;
    }
  };
};

// Transformation functions to convert raw K8s objects to frontend format
function transformNamespace(raw: any): Namespace {
  const metadata = raw.metadata || {};
  const status = raw.status || {};

  const fallbackNameParts = [
    metadata.uid,
    metadata.resourceVersion,
    metadata.creationTimestamp,
  ].filter((part) => typeof part === 'string' && part.trim().length > 0);
  const fallbackName = fallbackNameParts.length > 0
    ? `namespace-${fallbackNameParts[0]}`
    : 'namespace-unknown';

  const labelsObj = metadata.labels || {};
  const labels = Object.entries(labelsObj)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');

  return {
    name: metadata.name || fallbackName,
    phase: status.phase || 'Unknown',
    labels,
    age: metadata.creationTimestamp || '',
  };
}

function transformDeployment(raw: any): Deployment {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};
  
  const desired = spec.replicas ?? 1;
  const ready = status.readyReplicas ?? 0;
  const updated = status.updatedReplicas ?? 0;
  const available = status.availableReplicas ?? 0;
  
  const images = spec.template?.spec?.containers
    ?.map((c: any) => c.image)
    .filter((img: string) => img) || [];
  
  const selectorLabels = spec.selector?.matchLabels as Record<string, string> | undefined;
  
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
    selector_labels: selectorLabels,
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
  const timeZone = spec.timeZone || 'UTC';

  let nextExecution = '-';
  if (!suspend && schedule) {
    try {
      const interval = CronExpressionParser.parse(schedule, {
        currentDate: new Date(),
        tz: timeZone,
      });
      nextExecution = interval.next().toISOString() || '-';
    } catch {
      nextExecution = '-';
    }
  }
  
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    schedule,
    suspend,
    active,
    last_schedule: lastSchedule,
    next_execution: nextExecution,
    time_zone: timeZone,
    age: metadata.creationTimestamp || '',
    labels: (metadata.labels as Record<string, string> | undefined) ?? undefined,
    annotations: (metadata.annotations as Record<string, string> | undefined) ?? undefined,
  };
}

function transformEvent(raw: any): KubernetesEvent {
  const metadata = raw.metadata || {};
  const involvedObject = raw.involvedObject || {};
  const message = raw.message || raw.note || '';
  const firstTimestamp = raw.firstTimestamp || raw.deprecatedFirstTimestamp || metadata.creationTimestamp || '';
  const lastTimestamp =
    raw.lastTimestamp
    || raw.eventTime
    || raw.series?.lastObservedTime
    || raw.deprecatedLastTimestamp
    || metadata.creationTimestamp
    || '';
  
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    involved_object: `${involvedObject.kind || ''}/${involvedObject.name || ''}`,
    reason: raw.reason || '',
    message,
    count: raw.count || 1,
    first_timestamp: firstTimestamp,
    last_timestamp: lastTimestamp,
    type: raw.type || 'Normal',
  };
}

/** Check if node has meaningfully changed, with explicit conditions/taints comparison */
function nodeHasChanged(prev: K8sNode, current: K8sNode): boolean {
  // Always update if ready status changed
  if (prev.ready !== current.ready) return true;
  
  // Always update if unschedulable status changed
  if (prev.unschedulable !== current.unschedulable) return true;
  
  // Check if taints changed (by comparing stringified array)
  const prevTaints = (prev.taints || []).sort().join('|');
  const currTaints = (current.taints || []).sort().join('|');
  if (prevTaints !== currTaints) return true;
  
  // Check if conditions changed (by comparing stringified array)
  const prevConditions = JSON.stringify((prev.conditions || []).sort((a, b) => a.type.localeCompare(b.type)));
  const currConditions = JSON.stringify((current.conditions || []).sort((a, b) => a.type.localeCompare(b.type)));
  if (prevConditions !== currConditions) return true;
  
  // For other fields, use full JSON comparison
  return JSON.stringify(prev) !== JSON.stringify(current);
}

function transformNode(raw: any): K8sNode {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};
  const conditions = status.conditions || [];
  const readyCondition = conditions.find((c: any) => c.type === 'Ready');
  const ready = readyCondition ? readyCondition.status === 'True' : false;
  const normalizedConditions = conditions.map((condition: any) => ({
    type: condition?.type || '-',
    status: condition?.status || '-',
    reason: condition?.reason,
    message: condition?.message,
    last_transition_time: condition?.lastTransitionTime,
  }));
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
    conditions: normalizedConditions,
    roles: sortNodeRoles(roles),
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
  const specMetrics = Array.isArray(spec.metrics) ? spec.metrics : [];
  const currentMetrics = Array.isArray(status.currentMetrics) ? status.currentMetrics : [];
  const formatMetricTarget = (resourceMetric: any): string | undefined => {
    const target = resourceMetric?.target;
    if (!target) return undefined;
    if (typeof target.averageUtilization === 'number') return `${target.averageUtilization}%`;
    if (target.averageValue) return String(target.averageValue);
    if (target.value) return String(target.value);
    return undefined;
  };
  const formatMetricCurrent = (resourceMetric: any): string | undefined => {
    const current = resourceMetric?.current;
    if (!current) return undefined;
    if (typeof current.averageUtilization === 'number') return `${current.averageUtilization}%`;
    if (current.averageValue) return String(current.averageValue);
    if (current.value) return String(current.value);
    return undefined;
  };
  const cpuSpecMetric = specMetrics.find((m: any) => m?.resource?.name === 'cpu');
  const memorySpecMetric = specMetrics.find((m: any) => m?.resource?.name === 'memory');
  const cpuCurrentMetric = currentMetrics.find((m: any) => m?.resource?.name === 'cpu');
  const memoryCurrentMetric = currentMetrics.find((m: any) => m?.resource?.name === 'memory');
  const targets = status.currentMetrics?.length ?? 0;
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || 'default',
    reference: ref,
    targets,
    cpu_target: formatMetricTarget(cpuSpecMetric?.resource),
    cpu_current: formatMetricCurrent(cpuCurrentMetric?.resource),
    memory_target: formatMetricTarget(memorySpecMetric?.resource),
    memory_current: formatMetricCurrent(memoryCurrentMetric?.resource),
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
  const rules = spec.rules || [];
  const hosts = rules.map((r: any) => r.host).filter(Boolean).join(', ') || '-';
  const ingressClass = spec.ingressClassName || spec.ingress_class || spec.ingressClass || '-';
  const address = resolveIngressAddressForClass(ingressClass, raw);
  return {
    name: metadata.name || raw.name || '',
    namespace: metadata.namespace || raw.namespace || 'default',
    ingress_class: ingressClass,
    hosts: typeof raw.hosts === 'string' ? raw.hosts : hosts,
    address,
    rules: typeof raw.rules === 'number' ? raw.rules : rules.length,
    age: metadata.creationTimestamp
      ? new Date(metadata.creationTimestamp).toISOString()
      : (raw.age || ''),
    labels: (metadata.labels || raw.labels) as Record<string, string> | undefined,
    annotations: (metadata.annotations || raw.annotations) as Record<string, string> | undefined,
  };
}

function transformIngressClass(raw: any): IngressClass {
  const metadata = raw.metadata || {};
  const spec = raw.spec || {};
  const controller = spec.controller || raw.controller || '-';
  const isDefault = metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true'
    || raw.is_default === true;
  const params = spec.parameters ? `${spec.parameters.kind}/${spec.parameters.name}` : (raw.parameters || '-');
  return {
    name: metadata.name || raw.name || '',
    controller,
    is_default: isDefault,
    parameters: params,
    address: typeof raw.address === 'string' ? raw.address : '-',
    age: metadata.creationTimestamp
      ? new Date(metadata.creationTimestamp).toISOString()
      : (raw.age || ''),
    labels: (metadata.labels || raw.labels) as Record<string, string> | undefined,
    annotations: (metadata.annotations || raw.annotations) as Record<string, string> | undefined,
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

function isCustomResourceItemShape(raw: unknown): raw is CustomResource {
  return !!raw
    && typeof raw === 'object'
    && typeof (raw as CustomResource).name === 'string'
    && (raw as CustomResource).name.length > 0
    && ('spec' in (raw as object) || 'manifest' in (raw as object));
}

function transformCustomResource(raw: any): CustomResource {
  if (isCustomResourceItemShape(raw)) {
    const manifest = ((raw.manifest && typeof raw.manifest === 'object')
      ? raw.manifest
      : raw) as Record<string, unknown>;
    return {
      name: raw.name,
      namespace: raw.namespace ?? null,
      created_at: raw.created_at ?? null,
      spec: raw.spec ?? {},
      status: raw.status ?? null,
      labels: raw.labels,
      annotations: raw.annotations,
      manifest,
    };
  }

  const manifest = (raw?.manifest && typeof raw.manifest === 'object')
    ? raw.manifest
    : (raw && typeof raw === 'object' ? raw : null);
  const manifestMetadata = manifest && typeof manifest === 'object' && manifest.metadata && typeof manifest.metadata === 'object'
    ? manifest.metadata as Record<string, unknown>
    : {};
  const metadata = raw.metadata || {};
  const name = metadata.name || manifestMetadata.name || '';
  const namespace = metadata.namespace ?? manifestMetadata.namespace ?? null;
  const created_at = metadata.creationTimestamp ?? manifestMetadata.creationTimestamp
    ? new Date((metadata.creationTimestamp ?? manifestMetadata.creationTimestamp) as string).toISOString()
    : null;
  const spec = (raw.data && raw.data.spec) ? raw.data.spec : (raw.spec || {});
  const status = (raw.data && raw.data.status) != null ? raw.data.status : (raw.status != null ? raw.status : null);
  const labels = ((metadata.labels ?? manifestMetadata.labels) as Record<string, string> | undefined) ?? undefined;
  const annotations = ((metadata.annotations ?? manifestMetadata.annotations) as Record<string, string> | undefined) ?? undefined;
  return {
    name,
    namespace,
    created_at,
    spec,
    status,
    labels,
    annotations,
    manifest: manifest as Record<string, unknown> | null,
  };
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
    hasFetched: boolean;
    /** True only when backend signalled empty (e.g. subscribed + timeout), not when first item is still in flight */
    emptyListConfirmed: boolean;
  } {
    const [data, setData] = useState<T[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [hasFetched, setHasFetched] = useState(false);
    const [emptyListConfirmed, setEmptyListConfirmed] = useState(false);
    const [clusterSwitchVersion, setClusterSwitchVersion] = useState(0);

    useEffect(() => {
      const handleClusterSwitched = () => {
        setData([]);
        setError(null);
        setIsLoading(true);
        setHasFetched(false);
        setEmptyListConfirmed(false);
        setClusterSwitchVersion((v) => v + 1);
      };

      const handleResourcesRefresh = () => {
        setError(null);
        setIsLoading(true);
        setHasFetched(false);
        setEmptyListConfirmed(false);
        setClusterSwitchVersion((v) => v + 1);
      };

      window.addEventListener('cluster:switched', handleClusterSwitched);
      window.addEventListener('resources:refresh', handleResourcesRefresh);
      return () => {
        window.removeEventListener('cluster:switched', handleClusterSwitched);
        window.removeEventListener('resources:refresh', handleResourcesRefresh);
      };
    }, []);

    useEffect(() => {
      let emptyListTimeout: ReturnType<typeof setTimeout> | null = null;
      let reconcileInterval: ReturnType<typeof setInterval> | null = null;
      let aborted = false;
      let receivedRealtimeEvent = false;
      const abortController = new AbortController();

      let unsubscribe: (() => void) | null = null;

      const reconcileIntervalMs =
        resourceType === 'crds' ? 12_000
        : resourceType === 'helmreleases' ? 2_000
        : resourceType === 'nodes' ? 3_000
        : resourceType === 'ingresses' ? 5_000
        : null;

      if (reconcileIntervalMs !== null) {
        reconcileInterval = setInterval(() => {
          if (aborted || document.hidden) return;

          const reconcileAbortController = new AbortController();
          void (async () => {
            try {
              if (resourceType === 'ingresses') {
                await refreshIngressClassAddressMap(reconcileAbortController.signal);
              }
              const snapshot = await fetchRealtimeResourceSnapshot(
                resourceType,
                transformFn,
                reconcileAbortController.signal,
              );
              if (aborted) return;
              setData((prev) => {
                if (resourceType === 'nodes') {
                  const prevByKey = new Map(prev.map((item) => [getKey(item), item]));
                  const merged = (snapshot as K8sNode[]).map((node) => {
                    const previous = prevByKey.get(node.name) as K8sNode | undefined;
                    if (!previous) return node as T;
                    return {
                      ...node,
                      cpu_used: node.cpu_used ?? previous.cpu_used,
                      memory_used: node.memory_used ?? previous.memory_used,
                      ephemeral_storage_used:
                        node.ephemeral_storage_used ?? previous.ephemeral_storage_used,
                      cpu_usage_percent: node.cpu_usage_percent ?? previous.cpu_usage_percent,
                      memory_usage_percent:
                        node.memory_usage_percent ?? previous.memory_usage_percent,
                      ephemeral_storage_usage_percent:
                        node.ephemeral_storage_usage_percent
                        ?? previous.ephemeral_storage_usage_percent,
                    } as T;
                  });
                  return JSON.stringify(prev) === JSON.stringify(merged) ? prev : merged;
                }
                return JSON.stringify(prev) === JSON.stringify(snapshot) ? prev : snapshot;
              });
              setHasFetched(true);
              setIsLoading(false);
              setEmptyListConfirmed(snapshot.length === 0);
              setError(null);
            } catch {
              // Keep existing realtime state if reconcile snapshot fails.
            }
          })();
        }, reconcileIntervalMs);
      }

      const handleRealtimeMessage = (message: WebSocketMessage) => {
        if (message.type === 'resource_update' && message.resource === resourceType) {
          receivedRealtimeEvent = true;
          if (emptyListTimeout) {
            clearTimeout(emptyListTimeout);
            emptyListTimeout = null;
          }
          setHasFetched(true);
          setIsLoading(false);

          const action = message.action?.toUpperCase();
          const rawItem = message.data;
          if (!rawItem) return;

          if (resourceType === 'nodes' && (action === 'ADDED' || action === 'MODIFIED')) {
            const deletingName = (rawItem as any)?.metadata?.deletionTimestamp
              ? (rawItem as any)?.metadata?.name
              : undefined;
            if (deletingName) {
              setData((prev) => prev.filter((p) => getKey(p) !== deletingName));
              return;
            }
          }

          if (action === 'DELETED') {
            const itemKey = (() => {
              if (resourceType === 'helmreleases') {
                const release = rawItem as { namespace?: string; name?: string };
                if (release.namespace && release.name) {
                  return `${release.namespace}/${release.name}`;
                }
                return undefined;
              }
              if (resourceType === 'nodes') {
                return (rawItem as any)?.metadata?.name;
              } else if (resourceType === 'namespaces' || resourceType === 'events') {
                return (resourceType === 'events')
                  ? `${(rawItem as any)?.metadata?.namespace}/${(rawItem as any)?.metadata?.name}`
                  : (rawItem as any)?.metadata?.name;
              } else {
                return `${(rawItem as any)?.metadata?.namespace}/${(rawItem as any)?.metadata?.name}`;
              }
            })();

            if (itemKey) {
              setData((prev) => prev.filter((p) => getKey(p) !== itemKey));
            }
            return;
          }

          const item = transformFn(rawItem);

          if (action === 'ADDED' || action === 'MODIFIED') {
            setData((prev) => {
              const itemKey = getKey(item);
              const existingIndex = prev.findIndex((p) => getKey(p) === itemKey);
              if (existingIndex >= 0) {
                const prevItem = prev[existingIndex];
                const isNode = resourceType === 'nodes';
                // Watch payloads omit metrics.k8s.io usage — keep last REST-enriched values.
                const nextItem = isNode
                  ? ({
                      ...item,
                      cpu_used: (item as K8sNode).cpu_used ?? (prevItem as K8sNode).cpu_used,
                      memory_used: (item as K8sNode).memory_used ?? (prevItem as K8sNode).memory_used,
                      ephemeral_storage_used:
                        (item as K8sNode).ephemeral_storage_used
                        ?? (prevItem as K8sNode).ephemeral_storage_used,
                      cpu_usage_percent:
                        (item as K8sNode).cpu_usage_percent ?? (prevItem as K8sNode).cpu_usage_percent,
                      memory_usage_percent:
                        (item as K8sNode).memory_usage_percent
                        ?? (prevItem as K8sNode).memory_usage_percent,
                      ephemeral_storage_usage_percent:
                        (item as K8sNode).ephemeral_storage_usage_percent
                        ?? (prevItem as K8sNode).ephemeral_storage_usage_percent,
                    } as T)
                  : item;
                const hasChanged = isNode
                  ? nodeHasChanged(prevItem as any, nextItem as any)
                  : JSON.stringify(prevItem) !== JSON.stringify(nextItem);

                if (!hasChanged) return prev;
                const updated = [...prev];
                updated[existingIndex] = nextItem;
                if (resourceType === 'ingresses') {
                  return applyIngressControllerAddresses(updated as Ingress[]) as T[];
                }
                return updated;
              }
              const merged = [...prev, item];
              if (resourceType === 'ingresses') {
                return applyIngressControllerAddresses(merged as Ingress[]) as T[];
              }
              return merged;
            });
          }
          return;
        }

        if (message.type === 'subscribed' && message.resource === resourceType) {
          if (isRealtimeDebug()) console.log(`Subscribed to ${displayName}`);
          emptyListTimeout = setTimeout(() => {
            emptyListTimeout = null;
            setHasFetched(true);
            setIsLoading(false);
            setEmptyListConfirmed(true);
          }, 2000);
          return;
        }

        if (message.type === 'error') {
          if (shouldIgnoreRealtimeError(message.message)) {
            if (isRealtimeDebug()) {
              console.warn(`Ignoring realtime permission error for ${displayName}:`, message.message);
            }
            return;
          }
          if (isTransientRealtimeConnectivityError(message.message)) {
            if (isRealtimeDebug()) {
              console.warn(`Transient realtime connectivity issue for ${displayName}; retrying in background:`, message.message);
            }
            setError(null);
            return;
          }
          console.error(`WebSocket error for ${displayName}:`, message.message);
          setError(message.message || 'Unknown error');
        }
      };

      void (async () => {
        try {
          if (resourceType === 'ingresses') {
            await refreshIngressClassAddressMap(abortController.signal);
          }

          if (aborted) return;
          unsubscribe = subscribeRealtimeResource(resourceType, handleRealtimeMessage);

          const snapshot = await fetchRealtimeResourceSnapshot(
            resourceType,
            transformFn,
            abortController.signal,
          );
          if (aborted || receivedRealtimeEvent) {
            return;
          }
          setData(snapshot);
          setHasFetched(true);
          setIsLoading(false);
          setEmptyListConfirmed(snapshot.length === 0);
          setError(null);
        } catch (fetchError) {
          if (aborted) {
            return;
          }
          if (isFetchConnectionError(fetchError)) {
            setError(null);
            return;
          }
          const message = fetchError instanceof Error ? fetchError.message : 'Failed to fetch initial resources';
          if (isRealtimeDebug()) {
            console.warn(`Initial snapshot fetch failed for ${displayName}:`, message);
          }
        }
      })();

      return () => {
        aborted = true;
        abortController.abort();
        if (emptyListTimeout) {
          clearTimeout(emptyListTimeout);
        }
        if (reconcileInterval) {
          clearInterval(reconcileInterval);
        }
        unsubscribe?.();
      };
    }, [clusterSwitchVersion]);

    return { data, isLoading, error, hasFetched, emptyListConfirmed };
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

function transformHelmRelease(raw: unknown): HelmRelease {
  return raw as HelmRelease;
}

export const useRealtimeHelmReleases = createRealtimeHook<HelmRelease>(
  'helmreleases',
  'Helm Releases',
  transformHelmRelease,
  (item) => `${item.namespace}/${item.name}`,
);

function getCustomResourceKey(item: CustomResource): string {
  return item.namespace ? `${item.namespace}/${item.name}` : item.name;
}

const fetchCustomResourceSnapshot = async (
  crdName: string,
  signal: AbortSignal,
): Promise<CustomResource[]> => {
  const token = getAuthToken();
  const response = await fetch(`/api/crds/${encodeURIComponent(crdName)}/resources`, {
    cache: 'no-store',
    signal,
    headers: token ? { Authorization: token } : undefined,
  });

  const payload = await response.json().catch(() => ({})) as {
    data?: unknown[];
    warnings?: string[];
    error?: string;
    message?: string;
  };

  if (!response.ok) {
    const detail = payload.error || payload.message || response.statusText;
    throw new Error(detail || `Failed to fetch initial customresources/${crdName} snapshot`);
  }

  const items = Array.isArray(payload?.data) ? payload.data : [];

  return items.map((raw) => {
    if (isCustomResourceItemShape(raw)) {
      return transformCustomResource(raw);
    }
    const looksLikeRawK8sObject =
      raw
      && typeof raw === 'object'
      && raw !== null
      && typeof (raw as { metadata?: unknown }).metadata === 'object'
      && (raw as { metadata?: unknown }).metadata !== null;
    if (looksLikeRawK8sObject) {
      return transformCustomResource(raw);
    }
    return raw as CustomResource;
  });
};

/** Realtime list for a custom resource kind by CRD name (e.g. "crontabs.stable.example.com"). */
export function useRealtimeCustomResources(crdName: string | null): {
  data: CustomResource[];
  isLoading: boolean;
  error: string | null;
} {
  const [data, setData] = useState<CustomResource[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clusterSwitchVersion, setClusterSwitchVersion] = useState(0);
  const resourceType = crdName ? `customresources/${crdName}` : '';

  useEffect(() => {
    const handleClusterSwitched = () => {
      setData([]);
      setError(null);
      setIsLoading(true);
      setClusterSwitchVersion((v) => v + 1);
    };

    const handleResourcesRefresh = () => {
      setError(null);
      setIsLoading(true);
      setClusterSwitchVersion((v) => v + 1);
    };

    window.addEventListener('cluster:switched', handleClusterSwitched);
    window.addEventListener('resources:refresh', handleResourcesRefresh);
    return () => {
      window.removeEventListener('cluster:switched', handleClusterSwitched);
      window.removeEventListener('resources:refresh', handleResourcesRefresh);
    };
  }, []);

  useEffect(() => {
    setData([]);
    setError(null);
    setIsLoading(Boolean(crdName && resourceType));

    if (!crdName || !resourceType) {
      setIsLoading(false);
      return;
    }

    let emptyListTimeout: ReturnType<typeof setTimeout> | null = null;
    let reconcileInterval: ReturnType<typeof setInterval> | null = null;
    let aborted = false;
    let receivedRealtimeEvent = false;
    const abortController = new AbortController();

    void fetchCustomResourceSnapshot(crdName, abortController.signal)
      .then((snapshot) => {
        if (aborted || receivedRealtimeEvent) {
          return;
        }
        setData(snapshot);
        setIsLoading(false);
        setError(null);
      })
      .catch((fetchError) => {
        if (aborted) {
          return;
        }
        if (isFetchConnectionError(fetchError)) {
          setError(null);
          return;
        }
        const message = fetchError instanceof Error ? fetchError.message : 'Failed to fetch initial resources';
        if (isTransientK8sListError(message)) {
          setError(null);
          return;
        }
        if (isRealtimeDebug()) {
          console.warn(`Initial snapshot fetch failed for custom resource ${resourceType}:`, message);
        }
      });

    const RECONCILE_MS = 12_000;
    reconcileInterval = setInterval(() => {
      if (aborted || document.hidden) return;

      const reconcileAbortController = new AbortController();
      void fetchCustomResourceSnapshot(crdName, reconcileAbortController.signal)
        .then((snapshot) => {
          if (aborted) return;
          setData((prev) => (JSON.stringify(prev) === JSON.stringify(snapshot) ? prev : snapshot));
          setIsLoading(false);
          setError(null);
        })
        .catch(() => {
          // Keep existing realtime state if reconcile snapshot fails.
        });
    }, RECONCILE_MS);

    const unsubscribe = subscribeRealtimeResource(resourceType, (message) => {
      if (message.type === 'resource_update' && message.resource === resourceType) {
        receivedRealtimeEvent = true;
        if (emptyListTimeout) {
          clearTimeout(emptyListTimeout);
          emptyListTimeout = null;
        }
        setIsLoading(false);

        const action = message.action?.toUpperCase();
        const rawItem = message.data;
        if (!rawItem) return;

        if (action === 'DELETED') {
          const item = transformCustomResource(rawItem);
          const itemKey = getCustomResourceKey(item);
          setData((prev) => prev.filter((p) => getCustomResourceKey(p) !== itemKey));
          return;
        }

        if (action === 'ADDED' || action === 'MODIFIED') {
          const item = transformCustomResource(rawItem);
          const itemKey = getCustomResourceKey(item);
          setData((prev) => {
            const existingIndex = prev.findIndex((p) => getCustomResourceKey(p) === itemKey);
            if (existingIndex >= 0) {
              if (JSON.stringify(prev[existingIndex]) === JSON.stringify(item)) {
                return prev;
              }
              const updated = [...prev];
              updated[existingIndex] = item;
              return updated;
            }
            return [...prev, item];
          });
        }
        return;
      }

      if (message.type === 'subscribed' && message.resource === resourceType) {
        if (isRealtimeDebug()) console.log(`Subscribed to custom resource ${resourceType}`);
        emptyListTimeout = setTimeout(() => {
          emptyListTimeout = null;
          setIsLoading(false);
        }, 2000);
        return;
      }

      if (message.type === 'error') {
        if (shouldIgnoreRealtimeError(message.message)) {
          return;
        }
        if (isTransientRealtimeConnectivityError(message.message)) {
          setError(null);
          return;
        }
        setError(message.message || 'Unknown error');
      }
    });

    return () => {
      aborted = true;
      abortController.abort();
      if (emptyListTimeout) clearTimeout(emptyListTimeout);
      if (reconcileInterval) clearInterval(reconcileInterval);
      unsubscribe();
    };
  }, [crdName, resourceType, clusterSwitchVersion]);

  return { data, isLoading, error };
}
