import { useEffect, useState, useRef, useCallback } from 'react';
import { getAuthToken } from '../utils/auth';
import { isFetchConnectionError } from './useRealtimeResources';

export type ResourceType = 'pods' | 'deployments' | 'services' | 'nodes';

/** Show WebSocket debug logs in Vite dev or when running on localhost (e.g. local run with built app). */
const isRealtimeDebug = (): boolean =>
  typeof window !== 'undefined' &&
  (import.meta.env.DEV || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

interface UseRealtimePodsOptions {
  enabled?: boolean;
  reconnectInterval?: number;
}

const hasValue = (val: unknown): boolean => val !== undefined && val !== null && val !== '';

const hasMetricValue = (val: unknown): boolean => hasValue(val) && val !== '-';

const keepMetric = (nextVal: unknown, prevVal: unknown): unknown => {
  if (hasMetricValue(nextVal)) return nextVal;
  if (hasMetricValue(prevVal)) return prevVal;
  if (hasValue(nextVal)) return nextVal;
  if (hasValue(prevVal)) return prevVal;
  return '-';
};

const keepField = (nextVal: unknown, prevVal: unknown): unknown => {
  if (hasValue(nextVal)) return nextVal;
  return prevVal;
};

const isHealthyPodStatus = (status: unknown): boolean => {
  const normalized = String(status ?? '').trim().toLowerCase();
  return normalized === 'running' || normalized === 'completed' || normalized === 'succeeded';
};

const isTransientPodSyncFailureStatus = (status: number): boolean => {
  return status === 500 || status === 502 || status === 503 || status === 504;
};

const getFreelensLikeDisplayStatus = (pod: any): string => {
  const statusValue = typeof pod?.status === 'string' ? pod.status.trim() : '';
  const phaseValue = typeof pod?.phase === 'string' ? pod.phase.trim() : '';

  if (statusValue === 'Evicted' || statusValue === 'Terminating' || statusValue === 'Finalizing') {
    return statusValue;
  }

  return phaseValue || statusValue || 'Waiting';
};

const normalizeWatchAction = (action: unknown): 'ADDED' | 'MODIFIED' | 'DELETED' | null => {
  if (typeof action !== 'string') return null;
  const normalized = action.trim().toUpperCase();
  if (normalized === 'ADDED') return 'ADDED';
  if (normalized === 'MODIFIED' || normalized === 'APPLIED') return 'MODIFIED';
  if (normalized === 'DELETED') return 'DELETED';
  return null;
};

// Transform raw Kubernetes pod to frontend Pod type
const transformPod = (rawPod: any): any => {
  const metadata = rawPod.metadata || {};
  const status = rawPod.status || {};
  const spec = rawPod.spec || {};

  const formatProbe = (probe: any): string => {
    if (!probe) return '-';
    const parts: string[] = [];

    if (probe.httpGet) {
      const scheme = probe.httpGet.scheme || 'HTTP';
      parts.push(`HTTP ${scheme} ${probe.httpGet.path || '/'}:${probe.httpGet.port || '-'}`);
    } else if (probe.tcpSocket) {
      parts.push(`TCP ${probe.tcpSocket.port || '-'}`);
    } else if (probe.exec?.command?.length) {
      parts.push(`Exec ${probe.exec.command.join(' ')}`);
    }

    if (probe.initialDelaySeconds != null) parts.push(`delay ${probe.initialDelaySeconds}s`);
    if (probe.periodSeconds != null) parts.push(`period ${probe.periodSeconds}s`);

    return parts.length > 0 ? parts.join(' | ') : '-';
  };

  const formatResources = (resourceObj: any): string => {
    if (!resourceObj || typeof resourceObj !== 'object') return '-';
    const entries = Object.entries(resourceObj)
      .filter(([, value]) => value != null)
      .map(([key, value]) => `${key}: ${String(value)}`);
    return entries.length > 0 ? entries.join(', ') : '-';
  };

  // Calculate ready status
  const containerStatuses = status.containerStatuses || [];
  const initContainerStatuses = status.initContainerStatuses || [];
  const containers = spec.containers || [];
  const ownerReferences = metadata.ownerReferences || [];
  const ownerKind = ownerReferences[0]?.kind;
  const ownerName = ownerReferences[0]?.name;
  const controlledBy = ownerKind && ownerName ? `${ownerKind}/${ownerName}` : ownerKind || '-';
  const qos = status.qosClass || '-';
  const cpu = '-';
  const memory = '-';
  const readyCount = containerStatuses.filter((c: any) => c.ready).length;
  const totalCount = containers.length || containerStatuses.length || 0;
  const ready = totalCount > 0 ? `${readyCount}/${totalCount}` : '0/0';

  // Calculate restarts (both init and regular containers)
  const restarts = containerStatuses.reduce((sum: number, c: any) => sum + (c.restartCount || 0), 0);

  // Determine detailed pod status based on lifecycle
  let podStatus = status.phase || 'Unknown';
  const phase = status.phase || 'Unknown';
  let lastErrorMessage: string | undefined;

  const setLastError = (reason?: unknown, message?: unknown) => {
    if (lastErrorMessage) return;
    const reasonText = typeof reason === 'string' ? reason.trim() : '';
    const messageText = typeof message === 'string' ? message.trim() : '';
    if (reasonText && messageText) {
      lastErrorMessage = `${reasonText}: ${messageText}`;
      return;
    }
    if (messageText) {
      lastErrorMessage = messageText;
      return;
    }
    if (reasonText) {
      lastErrorMessage = reasonText;
    }
  };

  const getDisplayStatus = (): string => {
    if (status.reason === 'Evicted') {
      return 'Evicted';
    }

    if (metadata.deletionTimestamp) {
      const ephemeralContainerStatuses = status.ephemeralContainerStatuses || [];
      const allContainerStatuses = [
        ...containerStatuses,
        ...initContainerStatuses,
        ...ephemeralContainerStatuses,
      ];

      if (allContainerStatuses.some((containerStatus: any) => containerStatus.state?.running || containerStatus.state?.waiting)) {
        return 'Terminating';
      }

      if (Array.isArray(metadata.finalizers) && metadata.finalizers.length > 0) {
        return 'Finalizing';
      }
    }

    return phase || 'Waiting';
  };

  // Priority 1: Check for deletion/termination
  if (metadata.deletionTimestamp) {
    podStatus = 'Terminating';
  }
  // Priority 2: Check init containers (they run first)
  else if (initContainerStatuses.length > 0 && phase === 'Pending') {
    for (const initStatus of initContainerStatuses) {
      if (initStatus.state?.waiting) {
        podStatus = initStatus.state.waiting.reason || 'PodInitializing';
        setLastError(initStatus.state.waiting.reason, initStatus.state.waiting.message);
        break;
      } else if (initStatus.state?.running) {
        podStatus = 'PodInitializing';
        break;
      } else if (initStatus.state?.terminated && initStatus.state.terminated.exitCode !== 0) {
        podStatus = 'Init:' + (initStatus.state.terminated.reason || 'Error');
        setLastError(initStatus.state.terminated.reason, initStatus.state.terminated.message);
        break;
      }
    }
  }
  // Priority 3: Handle Pending phase
  else if (phase === 'Pending') {
    const conditions = status.conditions || [];
    const scheduledCondition = conditions.find((c: any) => c.type === 'PodScheduled');
    
    // Check if pod is unschedulable
    if (scheduledCondition && scheduledCondition.status === 'False') {
      podStatus = scheduledCondition.reason || 'Unschedulable';
      setLastError(scheduledCondition.reason, scheduledCondition.message);
    }
    // Check container statuses for specific waiting reasons
    else if (containerStatuses.length > 0) {
      let foundWaitingReason = false;
      for (const containerStatus of containerStatuses) {
        if (containerStatus.state?.waiting) {
          const reason = containerStatus.state.waiting.reason;
          if (reason) {
            podStatus = reason;
            setLastError(reason, containerStatus.state.waiting.message);
            foundWaitingReason = true;
            break;
          }
        } else if (containerStatus.state?.running) {
          // Container is running but pod phase is still Pending
          // This can happen during startup - check if ready
          if (readyCount < totalCount) {
            podStatus = 'ContainerStarting';
            foundWaitingReason = true;
            break;
          }
        }
      }
      if (!foundWaitingReason) {
        podStatus = 'ContainerCreating';
      }
    } else {
      podStatus = 'ContainerCreating';
    }
  }
  // Priority 4: Handle Running phase - check for issues
  else if (phase === 'Running') {
    let hasError = false;
    const errorWaitingReasons = [
      'CrashLoopBackOff',
      'ImagePullBackOff',
      'ErrImagePull',
      'ErrImageNeverPull',
      'CreateContainerConfigError',
      'InvalidImageName',
      'CreateContainerError',
      'PreStartHookError',
      'PostStartHookError'
    ];
    
    // Check for container issues (CrashLoopBackOff, errors, etc.)
    for (const containerStatus of containerStatuses) {
      // Check waiting state - only flag actual errors, not normal startup
      if (containerStatus.state?.waiting) {
        const reason = containerStatus.state.waiting.reason;
        if (reason && errorWaitingReasons.includes(reason)) {
          podStatus = reason;
          setLastError(reason, containerStatus.state.waiting.message);
          hasError = true;
          break;
        }
      }
      // Check terminated state (container crashed)
      else if (containerStatus.state?.terminated) {
        const reason = containerStatus.state.terminated.reason;
        if (reason && reason !== 'Completed') {
          podStatus = reason;
          setLastError(reason, containerStatus.state.terminated.message);
          hasError = true;
          break;
        }
      }
    }
    
    // If no errors found, check readiness
    if (!hasError) {
      // Check if not all containers are ready
      if (readyCount < totalCount) {
        podStatus = 'NotReady';
      } else {
        podStatus = 'Running';
      }
    }
  }
  // Priority 5: Handle Succeeded phase
  else if (phase === 'Succeeded') {
    podStatus = 'Completed';
  }
  // Priority 6: Handle Failed phase
  else if (phase === 'Failed') {
    // Try to get more specific reason from containers
    for (const containerStatus of containerStatuses) {
      if (containerStatus.state?.terminated) {
        const reason = containerStatus.state.terminated.reason;
        if (reason) {
          podStatus = reason;
          setLastError(reason, containerStatus.state.terminated.message);
          break;
        }
      }
    }
    if (podStatus === phase) {
      podStatus = 'Error';
    }
  }

  // Fallback: derive a user-facing error message from pod-level status/conditions
  // when container-level state does not expose one.
  if (!lastErrorMessage) {
    const normalizedStatus = String(podStatus).toLowerCase();
    const isHealthyStatus =
      normalizedStatus === 'running' ||
      normalizedStatus === 'completed' ||
      normalizedStatus === 'succeeded';

    if (!isHealthyStatus) {
      setLastError(status.reason, status.message);

      if (!lastErrorMessage) {
        const conditions = Array.isArray(status.conditions) ? status.conditions : [];
        const failingCondition = conditions.find(
          (condition: any) =>
            String(condition?.status).toLowerCase() === 'false' &&
            (typeof condition?.message === 'string' || typeof condition?.reason === 'string')
        );
        if (failingCondition) {
          setLastError(failingCondition.reason, failingCondition.message);
        }
      }
    }
  }

  const volumes = (spec.volumes || []).map((vol: any) => {
    const sourceType = Object.keys(vol || {}).find((k) => k !== 'name') || 'unknown';
    const source = vol?.[sourceType];
    return {
      name: vol?.name || '-',
      type: sourceType,
      source: source?.claimName || source?.secretName || source?.configMap?.name || source?.path || '-',
      read_only: Boolean(source?.readOnly),
    };
  });

  const containersDetailed = (spec.containers || []).map((container: any) => {
    const containerStatus = containerStatuses.find((s: any) => s.name === container.name);
    let state = 'Waiting';
    if (containerStatus?.state?.running) state = 'Running';
    else if (containerStatus?.state?.terminated) state = containerStatus.state.terminated.reason || 'Terminated';
    else if (containerStatus?.state?.waiting) state = containerStatus.state.waiting.reason || 'Waiting';

    const ports = (container?.ports || []).map((p: any) => `${p.name ? `${p.name}: ` : ''}${p.containerPort}/${p.protocol || 'TCP'}`);
    const environmentVariables = (container?.env || []).map((env: any) => {
      if (env.value != null) return { key: env.name, value: env.value, source: undefined };
      if (env.valueFrom?.fieldRef?.fieldPath) return { key: env.name, value: env.valueFrom.fieldRef.fieldPath, source: 'fieldRef' };
      if (env.valueFrom?.secretKeyRef?.name) return { key: env.name, value: `${env.valueFrom.secretKeyRef.name}/${env.valueFrom.secretKeyRef.key || ''}`, source: 'secret' };
      if (env.valueFrom?.configMapKeyRef?.name) return { key: env.name, value: `${env.valueFrom.configMapKeyRef.name}/${env.valueFrom.configMapKeyRef.key || ''}`, source: 'configMap' };
      return { key: env.name, value: '<valueFrom>', source: 'unknown' };
    });
    const mounts = (container?.volumeMounts || []).map((m: any) => `${m.name}: ${m.mountPath}${m.readOnly ? ' (ro)' : ''}`);

    const requests = formatResources(container?.resources?.requests);
    const limits = formatResources(container?.resources?.limits);
    const statusLabel = containerStatus?.ready ? 'Ready' : state;

    return {
      name: container?.name || '-',
      image: container?.image || '-',
      ready: Boolean(containerStatus?.ready),
      restart_count: containerStatus?.restartCount || 0,
      state,
      status: statusLabel,
      image_pull_policy: container?.imagePullPolicy || '-',
      ports,
      environment_variables: environmentVariables,
      mounts,
      liveness: formatProbe(container?.livenessProbe),
      readiness: formatProbe(container?.readinessProbe),
      startup: formatProbe(container?.startupProbe),
      requests,
      limits,
    };
  });

  const podIps = (status.podIPs || []).map((item: any) => item?.ip).filter(Boolean);
  const conditions = (status.conditions || []).map((condition: any) => ({
    type: condition?.type || '-',
    status: condition?.status || '-',
    reason: condition?.reason,
    last_transition_time: condition?.lastTransitionTime,
  }));

  const tolerations = (spec.tolerations || []).map((tol: any) => ({
    key: tol?.key || '<all>',
    operator: tol?.operator || 'Equal',
    effect: tol?.effect || '-',
    seconds: tol?.tolerationSeconds != null ? String(tol.tolerationSeconds) : '-',
    value: tol?.value,
  }));

  const antiAffinityRules: string[] = [];
  const requiredAnti = spec?.affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution || [];
  const preferredAnti = spec?.affinity?.podAntiAffinity?.preferredDuringSchedulingIgnoredDuringExecution || [];

  for (const term of requiredAnti) {
    const expr = term?.labelSelector?.matchExpressions?.[0];
    const key = expr?.key || '-';
    const op = expr?.operator || '-';
    const vals = Array.isArray(expr?.values) ? expr.values.join(',') : '';
    antiAffinityRules.push(`Required: ${key} ${op}${vals ? ` [${vals}]` : ''} on ${term?.topologyKey || '-'}`);
  }
  for (const pref of preferredAnti) {
    const term = pref?.podAffinityTerm;
    const expr = term?.labelSelector?.matchExpressions?.[0];
    const key = expr?.key || '-';
    const op = expr?.operator || '-';
    const vals = Array.isArray(expr?.values) ? expr.values.join(',') : '';
    antiAffinityRules.push(`Preferred(${pref?.weight || 0}): ${key} ${op}${vals ? ` [${vals}]` : ''} on ${term?.topologyKey || '-'}`);
  }

  return {
    name: metadata.name || '',
    namespace: metadata.namespace || '',
    created: metadata.creationTimestamp || '',
    status: podStatus,
    display_status: getDisplayStatus(),
    phase: phase,
    last_error: lastErrorMessage,
    ready,
    restarts,
    age: metadata.creationTimestamp || '',
    labels: metadata.labels || {},
    annotations: metadata.annotations || {},
    node: spec.nodeName || '',
    pod_ip: status.podIP || '',
    pod_ips: podIps,
    service_account: spec.serviceAccountName || '-',
    cpu,
    memory,
    controlled_by: controlledBy,
    qos,
    qos_class: qos,
    conditions,
    tolerations,
    pod_anti_affinities: antiAffinityRules,
    volumes,
    containers: containersDetailed,
    events: [],
  };
};

export const useRealtimePods = <T>(options: UseRealtimePodsOptions = {}) => {
  const { enabled = true, reconnectInterval = 3000 } = options;
  
  const [data, setData] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasFetched, setHasFetched] = useState(false);
  const [emptyListConfirmed, setEmptyListConfirmed] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number>();
  const reconnectAttemptsRef = useRef(0);
  const lastMessageAtRef = useRef<number>(Date.now());
  const intentionalCloseRef = useRef(false);
  const emptyListTimeoutRef = useRef<number>();
  const heartbeatIntervalRef = useRef<number>();
  const staleWatchdogRef = useRef<number>();
  const deletionTimeoutsRef = useRef<Map<string, number>>(new Map()); // Track deletion timeouts
  const deletedPodsRef = useRef<Set<string>>(new Set()); // Track deleted pods to prevent re-adding
  const apiMissCountsRef = useRef<Map<string, number>>(new Map()); // Track pods missing from REST across syncs
  const [clusterSwitchVersion, setClusterSwitchVersion] = useState(0);

  useEffect(() => {
    const handleClusterSwitched = () => {
      setData([]);
      setError(null);
      setIsConnected(false);
      setIsLoading(true);
      setHasFetched(false);
      setEmptyListConfirmed(false);
      reconnectAttemptsRef.current = 0;
      lastMessageAtRef.current = Date.now();
      deletedPodsRef.current.clear();
      apiMissCountsRef.current.clear();
      deletionTimeoutsRef.current.forEach(timeout => clearTimeout(timeout));
      deletionTimeoutsRef.current.clear();
      setClusterSwitchVersion((v) => v + 1);
    };

    window.addEventListener('cluster:switched', handleClusterSwitched);
    return () => {
      window.removeEventListener('cluster:switched', handleClusterSwitched);
    };
  }, []);

  const syncPodDetails = useCallback(async () => {
    const token = getAuthToken();

    try {
      const response = await fetch('/api/pods', {
        headers: token ? { Authorization: token } : undefined,
      });

      if (response.status === 401) {
        window.dispatchEvent(new CustomEvent('auth:expired'));
      }

      if (!response.ok) {
        if (isTransientPodSyncFailureStatus(response.status)) {
          // Keep retrying quietly while cluster/API connectivity recovers.
          setError(null);
          setIsLoading(false);
          return;
        }
        setError(`Failed to sync pod metrics (${response.status})`);
        setIsLoading(false);
        return;
      }
      const payload = await response.json();
      const apiPods: any[] = Array.isArray(payload?.data) ? (payload.data as any[]) : [];

      if (emptyListTimeoutRef.current) {
        clearTimeout(emptyListTimeoutRef.current);
        emptyListTimeoutRef.current = undefined;
      }
      setHasFetched(true);
      setIsLoading(false);
      setEmptyListConfirmed(apiPods.length === 0);

      setData((prevData) => {
        const keyOf = (item: any) => `${item.namespace}/${item.name}`;
        const apiByKey = new Map<string, any>(apiPods.map((item: any) => [keyOf(item), item]));
        const nextMissCounts = new Map<string, number>();

        // Keep all WS-driven pods; only inject metrics from REST so that pods
        // arriving via WebSocket are never removed by a single stale polling snapshot.
        const merged = prevData.flatMap((item: any) => {
          const apiItem = apiByKey.get(keyOf(item));
          if (!apiItem) {
            const key = keyOf(item);
            const missCount = (apiMissCountsRef.current.get(key) ?? 0) + 1;
            nextMissCounts.set(key, missCount);

            // If a pod disappears from the authoritative REST list, remove it on the
            // next reconciliation pass so stale redeploy pods don't linger in the table.
            if (missCount >= 1 && !deletedPodsRef.current.has(key)) {
              return [];
            }
            return [item];
          }

          nextMissCounts.delete(keyOf(item));

          const reconciledStatus = keepField(apiItem.status, item.status);
          const reconciledDisplayStatus = keepField(
            apiItem.display_status ?? getFreelensLikeDisplayStatus(apiItem),
            item.display_status
          );
          const shouldClearLastError =
            isHealthyPodStatus(reconciledDisplayStatus) || isHealthyPodStatus(reconciledStatus);

          return [{
            ...item,
            // Keep pod lifecycle fields fresh even when a websocket update is delayed/missed.
            status: reconciledStatus,
            display_status: reconciledDisplayStatus,
            phase: keepField(apiItem.phase, item.phase),
            last_error: shouldClearLastError ? undefined : keepField(apiItem.last_error, item.last_error),
            ready: keepField(apiItem.ready, item.ready),
            restarts: keepField(apiItem.restarts, item.restarts),
            node: keepField(apiItem.node, item.node),
            pod_ip: keepField(apiItem.pod_ip, item.pod_ip),
            age: keepField(apiItem.age, item.age),
            labels: keepField(apiItem.labels, item.labels),
            annotations: keepField(apiItem.annotations, item.annotations),
            cpu: keepMetric(apiItem.cpu, item.cpu),
            memory: keepMetric(apiItem.memory, item.memory),
            cpu_capacity: keepMetric(apiItem.cpu_capacity, item.cpu_capacity),
            memory_capacity: keepMetric(apiItem.memory_capacity, item.memory_capacity),
            cpu_usage_percent: apiItem.cpu_usage_percent ?? item.cpu_usage_percent,
            memory_usage_percent: apiItem.memory_usage_percent ?? item.memory_usage_percent,
            // WS wins for controlled_by/qos when it has a real value
            controlled_by: item.controlled_by !== '-' ? item.controlled_by : (apiItem.controlled_by ?? item.controlled_by),
            qos: item.qos !== '-' ? item.qos : (apiItem.qos ?? item.qos),
          }];
        });

        const existingKeys = new Set(merged.map((item: any) => keyOf(item)));
        for (const apiItem of apiPods) {
          const key = keyOf(apiItem);
          // Don't re-add pods that were recently deleted
          if (!existingKeys.has(key) && !deletedPodsRef.current.has(key)) {
            merged.push({
              ...apiItem,
              display_status: apiItem.display_status ?? getFreelensLikeDisplayStatus(apiItem),
            } as T);
          }
        }

        // Persist miss counters only for pods currently tracked in state.
        for (const item of merged as any[]) {
          const key = keyOf(item);
          if (!nextMissCounts.has(key) && apiByKey.has(key)) {
            nextMissCounts.set(key, 0);
          }
        }
        apiMissCountsRef.current = nextMissCounts;

        return merged as T[];
      });
    } catch (syncError) {
      if (!isFetchConnectionError(syncError) && isRealtimeDebug()) {
        console.warn('[useRealtimePods] Failed to sync pod details:', syncError);
      }
      // Network interruptions are transient; keep background retry active
      // without surfacing hard table errors.
      setError(null);
      setIsLoading(false);
    }
  }, []);

  const connect = useCallback(() => {
    if (!enabled) return;

    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

    try {
      intentionalCloseRef.current = false;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (intentionalCloseRef.current) {
          ws.close();
          return;
        }

        if (isRealtimeDebug()) console.log('[useRealtimePods] WebSocket connected');
        setIsConnected(true);
        setError(null);
        reconnectAttemptsRef.current = 0;
        lastMessageAtRef.current = Date.now();

        if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 15000);

        if (staleWatchdogRef.current) clearInterval(staleWatchdogRef.current);
        staleWatchdogRef.current = window.setInterval(() => {
          const staleForMs = Date.now() - lastMessageAtRef.current;
          if (ws.readyState === WebSocket.OPEN && staleForMs > 45000) {
            if (isRealtimeDebug()) {
              console.warn(`[useRealtimePods] No messages for ${staleForMs}ms, reconnecting stale socket`);
            }
            ws.close();
          }
        }, 10000);

        // Subscribe to pods
        ws.send(JSON.stringify({
          type: 'subscribe',
          resource: 'pods'
        }));

        // Hydrate full pod rows (including cpu/memory metrics) as soon as socket connects.
        void syncPodDetails();
      };

      ws.onmessage = (event) => {
        lastMessageAtRef.current = Date.now();
        try {
          const message = JSON.parse(event.data);

          if (message.type === 'resource_update' && message.resource === 'pods') {
            if (emptyListTimeoutRef.current) {
              clearTimeout(emptyListTimeoutRef.current);
              emptyListTimeoutRef.current = undefined;
            }
            setHasFetched(true);
            setIsLoading(false);
            setEmptyListConfirmed(false);
            const { action, data: rawPodData } = message;
            const normalizedAction = normalizeWatchAction(action);
            if (!normalizedAction) {
              return;
            }
            const transformedPod = transformPod(rawPodData);
            
            // Debug log for status changes (dev only)
            if (isRealtimeDebug() && (transformedPod.status === 'NotReady' ||
                transformedPod.status === 'ContainerStarting' ||
                transformedPod.status === 'Terminating')) {
              console.log(`[useRealtimePods] ${action} pod: ${transformedPod.namespace}/${transformedPod.name} - Status: ${transformedPod.status}, Ready: ${transformedPod.ready}`);
            }

            setData((prevData) => {
              switch (normalizedAction) {
                case 'ADDED':
                  const podKey = `${transformedPod.namespace}/${transformedPod.name}`;
                  
                  // Don't add if pod was deleted
                  if (deletedPodsRef.current.has(podKey)) {
                    if (isRealtimeDebug()) console.log(`[useRealtimePods] Ignoring ADDED for deleted pod: ${podKey}`);
                    return prevData;
                  }
                  
                  // Check if already exists
                  const exists = prevData.some((item: any) => {
                    const itemRaw = item as any;
                    return itemRaw.name === transformedPod.name && 
                           itemRaw.namespace === transformedPod.namespace;
                  });
                  if (exists) {
                    // Update existing pod instead of skipping
                    return prevData.map((item: any) => {
                      const itemRaw = item as any;
                      const existingPod = itemRaw.name === transformedPod.name && 
                        itemRaw.namespace === transformedPod.namespace
                        ? itemRaw
                        : null;
                      return (itemRaw.name === transformedPod.name && 
                             itemRaw.namespace === transformedPod.namespace) 
                        ? ({
                            ...transformedPod,
                            cpu: keepMetric(transformedPod.cpu, existingPod?.cpu),
                            memory: keepMetric(transformedPod.memory, existingPod?.memory),
                            cpu_capacity: keepMetric(transformedPod.cpu_capacity, existingPod?.cpu_capacity),
                            memory_capacity: keepMetric(transformedPod.memory_capacity, existingPod?.memory_capacity),
                            cpu_usage_percent: transformedPod.cpu_usage_percent ?? existingPod?.cpu_usage_percent,
                            memory_usage_percent: transformedPod.memory_usage_percent ?? existingPod?.memory_usage_percent,
                            controlled_by:
                              transformedPod.controlled_by !== '-' ? transformedPod.controlled_by : (existingPod?.controlled_by || '-'),
                            qos: transformedPod.qos !== '-' ? transformedPod.qos : (existingPod?.qos || '-'),
                          } as T)
                        : item;
                    });
                  }
                  return [...prevData, transformedPod as T];
                
                case 'MODIFIED':
                  const modPodKey = `${transformedPod.namespace}/${transformedPod.name}`;
                  
                  // Don't modify if pod was deleted
                  if (deletedPodsRef.current.has(modPodKey)) {
                    if (isRealtimeDebug()) console.log(`[useRealtimePods] Ignoring MODIFIED for deleted pod: ${modPodKey}`);
                    return prevData;
                  }
                  
                  // Upsert pattern: update if exists, add if not
                  const foundIndex = prevData.findIndex((item: any) => {
                    const itemRaw = item as any;
                    return itemRaw.name === transformedPod.name && 
                           itemRaw.namespace === transformedPod.namespace;
                  });
                  
                  if (foundIndex >= 0) {
                    // Update existing
                    const updated = [...prevData];
                    const oldStatus = (updated[foundIndex] as any).status;
                    const existingPod = updated[foundIndex] as any;
                    const mergedPod = {
                      ...transformedPod,
                      cpu: keepMetric(transformedPod.cpu, existingPod.cpu),
                      memory: keepMetric(transformedPod.memory, existingPod.memory),
                      cpu_capacity: keepMetric(transformedPod.cpu_capacity, existingPod.cpu_capacity),
                      memory_capacity: keepMetric(transformedPod.memory_capacity, existingPod.memory_capacity),
                      cpu_usage_percent: transformedPod.cpu_usage_percent ?? existingPod.cpu_usage_percent,
                      memory_usage_percent: transformedPod.memory_usage_percent ?? existingPod.memory_usage_percent,
                      controlled_by: transformedPod.controlled_by !== '-' ? transformedPod.controlled_by : (existingPod.controlled_by || '-'),
                      qos: transformedPod.qos !== '-' ? transformedPod.qos : (existingPod.qos || '-'),
                    };

                    // Skip update if nothing actually changed (avoids unnecessary re-renders / chart flicker)
                    if (JSON.stringify(existingPod) === JSON.stringify(mergedPod)) return prevData;

                    updated[foundIndex] = mergedPod as T;
                    
                    // Log status transitions (dev only)
                    if (oldStatus !== mergedPod.status) {
                      if (isRealtimeDebug()) console.log(`[useRealtimePods] Status transition for ${modPodKey}: ${oldStatus} -> ${mergedPod.status}`);
                      
                      // If transitioning to Terminating, keep it visible until DELETED event
                      if (mergedPod.status === 'Terminating') {
                        // Clear any existing timeout
                        const existingTimeout = deletionTimeoutsRef.current.get(modPodKey);
                        if (existingTimeout) {
                          clearTimeout(existingTimeout);
                          deletionTimeoutsRef.current.delete(modPodKey);
                        }
                      }
                    }
                    
                    return updated;
                  } else {
                    // Add new (pod wasn't in initial list)
                    if (isRealtimeDebug()) console.log(`[useRealtimePods] Adding pod from MODIFIED: ${modPodKey} (status: ${transformedPod.status})`);
                    const newList = [...prevData, transformedPod as T];
                    
                    // Keep terminating pods until DELETED event
                    if (transformedPod.status === 'Terminating') {
                      const existingTimeout = deletionTimeoutsRef.current.get(modPodKey);
                      if (existingTimeout) {
                        clearTimeout(existingTimeout);
                        deletionTimeoutsRef.current.delete(modPodKey);
                      }
                    }
                    
                    return newList;
                  }
                
                case 'DELETED':
                  const podKeyForDeletion = `${transformedPod.namespace}/${transformedPod.name}`;
                  if (isRealtimeDebug()) console.log(`[useRealtimePods] Deleting pod immediately: ${podKeyForDeletion}`);
                  
                  // Mark as deleted to prevent re-adding
                  deletedPodsRef.current.add(podKeyForDeletion);
                  
                  // Clear any pending auto-removal timeout
                  const existingTimeout = deletionTimeoutsRef.current.get(podKeyForDeletion);
                  if (existingTimeout) {
                    clearTimeout(existingTimeout);
                    deletionTimeoutsRef.current.delete(podKeyForDeletion);
                  }
                  
                  // Remove immediately - no delay
                  const finalFiltered = prevData.filter((item: any) => {
                    const itemRaw = item as any;
                    return !(itemRaw.name === transformedPod.name && 
                            itemRaw.namespace === transformedPod.namespace);
                  });
                  
                  if (isRealtimeDebug()) console.log(`[useRealtimePods] Pod count: ${prevData.length} -> ${finalFiltered.length}`);
                  
                  // Keep deleted marker very briefly so stale events do not re-add old pod,
                  // but new same-name pod can appear quickly.
                  setTimeout(() => {
                    deletedPodsRef.current.delete(podKeyForDeletion);
                  }, 500);
                  
                  return finalFiltered;
                
                default:
                  return prevData;
              }
            });
          } else if (message.type === 'subscribed' && message.resource === 'pods') {
            if (isRealtimeDebug()) console.log('[useRealtimePods] Subscription confirmed');
            if (emptyListTimeoutRef.current) {
              clearTimeout(emptyListTimeoutRef.current);
            }
            // If no pod events arrive shortly after subscribe, confirm empty list and stop loading.
            emptyListTimeoutRef.current = window.setTimeout(() => {
              setHasFetched(true);
              setIsLoading(false);
              setEmptyListConfirmed(true);
              emptyListTimeoutRef.current = undefined;
            }, 2000);
          } else if (message.type === 'error') {
            console.error('[useRealtimePods] Server error:', message.message);
            setError(message.message);
            if (!hasFetched) {
              setIsLoading(false);
            }
          }
        } catch (err) {
          console.error('[useRealtimePods] Failed to parse message:', err);
        }
      };

      ws.onerror = (errorEvent) => {
        if (intentionalCloseRef.current) {
          return;
        }
        if (import.meta.env.DEV && ws.readyState !== WebSocket.OPEN) {
          if (isRealtimeDebug()) {
            console.log('[useRealtimePods] Ignoring pre-open websocket error during dev remount');
          }
          return;
        }
        console.error('[useRealtimePods] WebSocket error:', errorEvent);
        // Don't set error here — onclose fires immediately after and handles reconnection.
        // Only surface an error if reconnection is exhausted (handled in onclose).
      };

      ws.onclose = () => {
        if (intentionalCloseRef.current) {
          if (isRealtimeDebug()) console.log('[useRealtimePods] WebSocket closed intentionally');
          return;
        }
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = undefined;
        }
        if (staleWatchdogRef.current) {
          clearInterval(staleWatchdogRef.current);
          staleWatchdogRef.current = undefined;
        }
        if (isRealtimeDebug()) console.log('[useRealtimePods] WebSocket closed');
        setIsConnected(false);
        wsRef.current = null;

        // Attempt reconnection
        if (enabled) {
          reconnectAttemptsRef.current += 1;
          if (isRealtimeDebug()) console.log(
            `[useRealtimePods] Reconnecting... (attempt ${reconnectAttemptsRef.current})`
          );
          const jitter = (reconnectAttemptsRef.current % 5) * 120;
          const backoff = Math.min(5000, Math.max(0, reconnectAttemptsRef.current - 1) * 600);
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, reconnectInterval + backoff + jitter);
        }
      };

      wsRef.current = ws;
    } catch (err) {
      console.error('[useRealtimePods] Failed to create WebSocket:', err);
      setError('Failed to create WebSocket connection');
    }
  }, [enabled, reconnectInterval]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = undefined;
    }
    if (staleWatchdogRef.current) {
      clearInterval(staleWatchdogRef.current);
      staleWatchdogRef.current = undefined;
    }
    if (wsRef.current) {
      const ws = wsRef.current;
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.onopen = () => {
          ws.close();
        };
      } else if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
        ws.close();
      }
      wsRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (emptyListTimeoutRef.current) {
      clearTimeout(emptyListTimeoutRef.current);
      emptyListTimeoutRef.current = undefined;
    }
    
    // Clear all pending deletion timeouts
    deletionTimeoutsRef.current.forEach(timeout => clearTimeout(timeout));
    deletionTimeoutsRef.current.clear();
    
    setIsConnected(false);
  }, []);

  useEffect(() => {
    if (enabled) {
      setIsLoading(true);
      setHasFetched(false);
      setEmptyListConfirmed(false);
      // Stagger initial connect a bit to reduce websocket burst during route/hot updates.
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, 180);
    }

    return () => {
      disconnect();
      if (emptyListTimeoutRef.current) {
        clearTimeout(emptyListTimeoutRef.current);
        emptyListTimeoutRef.current = undefined;
      }
      // Clear all deletion timeouts on unmount
      deletionTimeoutsRef.current.forEach(timeout => clearTimeout(timeout));
      deletionTimeoutsRef.current.clear();
    };
  }, [enabled, connect, disconnect, clusterSwitchVersion]);

  useEffect(() => {
    if (!enabled) return;

    syncPodDetails();
    const interval = window.setInterval(() => {
      syncPodDetails();
    }, 5000);

    return () => clearInterval(interval);
  }, [enabled, syncPodDetails]);

  return {
    data,
    isLoading,
    hasFetched,
    emptyListConfirmed,
    isConnected,
    error,
    reconnect: connect,
    disconnect,
  };
};
