import { useEffect, useState, useRef, useCallback } from 'react';
import { getAuthToken } from '../utils/auth';

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
  
  // Priority 1: Check for deletion/termination
  if (metadata.deletionTimestamp) {
    podStatus = 'Terminating';
  }
  // Priority 2: Check init containers (they run first)
  else if (initContainerStatuses.length > 0 && phase === 'Pending') {
    for (const initStatus of initContainerStatuses) {
      if (initStatus.state?.waiting) {
        podStatus = initStatus.state.waiting.reason || 'PodInitializing';
        break;
      } else if (initStatus.state?.running) {
        podStatus = 'PodInitializing';
        break;
      } else if (initStatus.state?.terminated && initStatus.state.terminated.exitCode !== 0) {
        podStatus = 'Init:' + (initStatus.state.terminated.reason || 'Error');
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
    }
    // Check container statuses for specific waiting reasons
    else if (containerStatuses.length > 0) {
      let foundWaitingReason = false;
      for (const containerStatus of containerStatuses) {
        if (containerStatus.state?.waiting) {
          const reason = containerStatus.state.waiting.reason;
          if (reason) {
            podStatus = reason;
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
          hasError = true;
          break;
        }
      }
      // Check terminated state (container crashed)
      else if (containerStatus.state?.terminated) {
        const reason = containerStatus.state.terminated.reason;
        if (reason && reason !== 'Completed') {
          podStatus = reason;
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
          break;
        }
      }
    }
    if (podStatus === phase) {
      podStatus = 'Error';
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
    phase: phase,
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
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasFetched, setHasFetched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasFetchedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number>();
  const emptyListTimeoutRef = useRef<number>();
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 10;
  const deletionTimeoutsRef = useRef<Map<string, number>>(new Map()); // Track deletion timeouts
  const deletedPodsRef = useRef<Set<string>>(new Set()); // Track deleted pods to prevent re-adding

  const markFetched = useCallback(() => {
    if (!hasFetchedRef.current) {
      hasFetchedRef.current = true;
      setHasFetched(true);
    }
    setIsLoading(false);
  }, []);

  const syncPodDetails = useCallback(async () => {
    const token = getAuthToken();
    if (!token) return;

    try {
      const response = await fetch('/api/pods', {
        headers: {
          Authorization: token,
        },
      });

      if (!response.ok) return;

      const payload = await response.json();
      const apiPods: any[] = Array.isArray(payload?.data) ? (payload.data as any[]) : [];

      setData((prevData) => {
        const keyOf = (item: any) => `${item.namespace}/${item.name}`;
        const apiByKey = new Map<string, any>(apiPods.map((item: any) => [keyOf(item), item]));

        // Use API response as source of truth for existence, so deleted pods are
        // removed even if a websocket DELETED event is missed.
        const merged = prevData
          .filter((item: any) => apiByKey.has(keyOf(item)))
          .map((item: any) => {
            const apiItem = apiByKey.get(keyOf(item));

            return {
              ...item,
              cpu: keepMetric(apiItem.cpu, item.cpu),
              memory: keepMetric(apiItem.memory, item.memory),
              cpu_capacity: keepMetric(apiItem.cpu_capacity, item.cpu_capacity),
              memory_capacity: keepMetric(apiItem.memory_capacity, item.memory_capacity),
              cpu_usage_percent: apiItem.cpu_usage_percent ?? item.cpu_usage_percent,
              memory_usage_percent: apiItem.memory_usage_percent ?? item.memory_usage_percent,
              controlled_by: apiItem.controlled_by ?? item.controlled_by,
              qos: apiItem.qos ?? item.qos,
            };
          });

        const existingKeys = new Set(merged.map((item: any) => keyOf(item)));
        for (const apiItem of apiPods) {
          const key = keyOf(apiItem);
          // Don't re-add pods that were recently deleted
          if (!existingKeys.has(key) && !deletedPodsRef.current.has(key)) {
            merged.push(apiItem as T);
          }
        }

        return merged as T[];
      });
    } catch (syncError) {
      console.error('[useRealtimePods] Failed to sync pod details:', syncError);
    }
  }, []);

  const connect = useCallback(() => {
    if (!enabled) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname;
    const port = window.location.port ? `:${window.location.port}` : '';
    const wsUrl = `${protocol}//${host}${port}/ws`;

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (isRealtimeDebug()) console.log('[useRealtimePods] WebSocket connected');
        setIsConnected(true);
        setError(null);
        reconnectAttemptsRef.current = 0;

        // Subscribe to pods
        ws.send(JSON.stringify({
          type: 'subscribe',
          resource: 'pods'
        }));
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          if (message.type === 'resource_update' && message.resource === 'pods') {
            if (emptyListTimeoutRef.current) {
              clearTimeout(emptyListTimeoutRef.current);
              emptyListTimeoutRef.current = undefined;
            }
            markFetched();

            const { action, data: rawPodData } = message;
            const transformedPod = transformPod(rawPodData);
            
            // Debug log for status changes (dev only)
            if (isRealtimeDebug() && (transformedPod.status === 'NotReady' ||
                transformedPod.status === 'ContainerStarting' ||
                transformedPod.status === 'Terminating')) {
              console.log(`[useRealtimePods] ${action} pod: ${transformedPod.namespace}/${transformedPod.name} - Status: ${transformedPod.status}, Ready: ${transformedPod.ready}`);
            }

            setData((prevData) => {
              switch (action) {
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
          } else if (message.type === 'subscribed') {
            if (isRealtimeDebug()) console.log('[useRealtimePods] Subscription confirmed');
            // Avoid showing empty state immediately while first events are still in flight.
            if (!hasFetchedRef.current) {
              if (emptyListTimeoutRef.current) {
                clearTimeout(emptyListTimeoutRef.current);
              }
              emptyListTimeoutRef.current = window.setTimeout(() => {
                emptyListTimeoutRef.current = undefined;
                markFetched();
              }, 2000);
            }
          } else if (message.type === 'error') {
            console.error('[useRealtimePods] Server error:', message.message);
            setError(message.message);
          }
        } catch (err) {
          console.error('[useRealtimePods] Failed to parse message:', err);
        }
      };

      ws.onerror = (errorEvent) => {
        console.error('[useRealtimePods] WebSocket error:', errorEvent);
        setError('WebSocket connection error');
      };

      ws.onclose = () => {
        if (isRealtimeDebug()) console.log('[useRealtimePods] WebSocket closed');
        setIsConnected(false);
        wsRef.current = null;

        // Attempt reconnection
        if (
          enabled &&
          reconnectAttemptsRef.current < maxReconnectAttempts
        ) {
          reconnectAttemptsRef.current += 1;
          if (isRealtimeDebug()) console.log(
            `[useRealtimePods] Reconnecting... (attempt ${reconnectAttemptsRef.current}/${maxReconnectAttempts})`
          );
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, reconnectInterval);
        } else if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
          setError('Max reconnection attempts reached');
        }
      };

      wsRef.current = ws;
    } catch (err) {
      console.error('[useRealtimePods] Failed to create WebSocket:', err);
      setError('Failed to create WebSocket connection');
    }
  }, [enabled, reconnectInterval, markFetched]);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
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
      connect();
    }

    return () => {
      disconnect();
      // Clear all deletion timeouts on unmount
      deletionTimeoutsRef.current.forEach(timeout => clearTimeout(timeout));
      deletionTimeoutsRef.current.clear();
    };
  }, [enabled, connect, disconnect]);

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
    isConnected,
    error,
    reconnect: connect,
    disconnect,
    isLoading,
    hasFetched,
  };
};
