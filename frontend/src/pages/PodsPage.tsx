import { useEffect, useMemo, useState } from 'react';
import YAML from 'yaml';
import { Trash2 } from '../components/Icons';
import { useRealtimePods } from '../hooks/useRealtimePods';
import { useRealtimeEvents } from '../hooks/useRealtimeResources';
import { useNamespace } from '../context/NamespaceContext';
import { DataTable } from '../components/DataTable';
import { PodDetailPanel } from '../components/PodDetailPanel';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { StatusBadge } from '../components/StatusBadge';
import type { Pod } from '../types';
import {
  timeAgo,
  matchesResourceNameFilter,
  formatCpuCores,
  parseCpuToCores,
  parseK8sMemoryToGB,
  parseK8sQuantityToBytes,
} from '../utils';
import { getAuthToken } from '../utils/auth';
import { deletePod, fetchSecretData } from '../hooks/useKubernetes';
import { openPanelTab } from '../components/BottomPanel';

type PodSortKey =
  | 'name'
  | 'namespace'
  | 'node'
  | 'status'
  | 'ready'
  | 'restarts'
  | 'cpu'
  | 'memory'
  | 'controlled_by'
  | 'qos'
  | 'age';

const sanitizePodYamlForEdit = (yamlText: string) => {
  try {
    const parsed = YAML.parse(yamlText) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return yamlText;

    const metadata = (parsed.metadata as Record<string, unknown> | undefined) ?? undefined;
    if (metadata && typeof metadata === 'object') {
      delete metadata.managedFields;
      delete metadata.resourceVersion;
      delete metadata.uid;
      delete metadata.generation;
      delete metadata.creationTimestamp;
      delete metadata.selfLink;

      const annotations = metadata.annotations as Record<string, unknown> | undefined;
      if (annotations && typeof annotations === 'object') {
        delete annotations['kubectl.kubernetes.io/last-applied-configuration'];
        if (Object.keys(annotations).length === 0) delete metadata.annotations;
      }
    }

    delete parsed.status;

    return YAML.stringify(parsed, { lineWidth: 0 });
  } catch {
    return yamlText;
  }
};

const formatPodMemoryGb = (value?: string | null): string => {
  if (!value || value === '-') return '-';
  const gb = parseK8sMemoryToGB(value);
  if (!Number.isFinite(gb) || gb <= 0) return '-';
  return `${gb >= 10 ? gb.toFixed(1) : gb.toFixed(2)} GB`;
};

export const PodsPage = () => {
  const [, forceUpdate] = useState({});
  
  // WebSocket realtime data (always enabled)
  const { data, isConnected, error } = useRealtimePods<Pod>({
    enabled: true,
  });
  const { data: eventsData } = useRealtimeEvents();
  
  const isLoading = !isConnected && data.length === 0;
  
  const { selectedNamespaces, resourceNameFilter } = useNamespace();
  const [selectedPod, setSelectedPod] = useState<Pod | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [decodedSecrets, setDecodedSecrets] = useState<Record<string, Record<string, string>>>({});
  const [sortState, setSortState] = useState<{ key: PodSortKey; direction: 'asc' | 'desc' }>({
    key: 'age',
    direction: 'desc',
  });

  const handleOpenYamlTab = async (pod: Pod) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const response = await fetch(`/api/pods/${pod.namespace}/${pod.name}/yaml`, {
        headers: token ? { Authorization: token } : {},
      });
      if (!response.ok) throw new Error(`Failed to load YAML: ${response.statusText}`);
      const yaml = await response.text();
      openPanelTab({ type: 'yaml-editor', yamlContent: sanitizePodYamlForEdit(yaml), title: pod.name });
    } catch {
      // silently ignore — the YAML editor will start empty
      openPanelTab({ type: 'yaml-editor' });
    }
  };

  const handleOpenShellTab = (pod: Pod) => {
    setPanelOpen(false);
    openPanelTab({ type: 'pod-exec', podName: pod.name, namespace: pod.namespace });
  };

  const handleOpenLogsTab = (pod: Pod) => {
    setPanelOpen(false);
    openPanelTab({ type: 'logs', podName: pod.name, namespace: pod.namespace });
  };

  const handleDeleteSingle = async (namespace: string, name: string) => {
    setConfirmDelete({ keys: [`${namespace}/${name}`], label: name });
    setPanelOpen(false);
  };

  const handleDeleteSelected = () => {
    if (selectedRows.length === 0) return;
    setConfirmDelete({
      keys: selectedRows,
      label: selectedRows.length === 1 ? selectedRows[0].split('/')[1] : `${selectedRows.length} pods`,
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try {
      await Promise.all(
        confirmDelete.keys.map((key) => {
          const [ns, name] = key.split('/');
          return deletePod(ns, name);
        })
      );
      setSelectedRows([]);
      setConfirmDelete(null);
    } finally {
      setIsDeleting(false);
    }
  };

  // Fetch and decode secret data for selected pod
  useEffect(() => {
    if (!selectedPod || !selectedPod.containers) {
      setDecodedSecrets({});
      return;
    }

    const fetchSecrets = async () => {
      const secretNames = new Set<string>();

      selectedPod.containers?.forEach((container) => {
        container.environment_variables?.forEach((env) => {
          if (env.source === 'secret' && env.value) {
            const idx = env.value.lastIndexOf('/');
            if (idx > 0) {
              const secretName = env.value.substring(0, idx);
              if (secretName) secretNames.add(secretName);
            }
          }
        });
      });

      if (secretNames.size === 0) {
        setDecodedSecrets({});
        return;
      }

      const resolved: Record<string, Record<string, string>> = {};
      await Promise.allSettled(
        Array.from(secretNames).map(async (secretName) => {
          const data = await fetchSecretData(selectedPod.namespace, secretName);
          if (data && Object.keys(data).length > 0) {
            resolved[`${selectedPod.namespace}/${secretName}`] = data;
          }
        })
      );

      setDecodedSecrets(resolved);
    };

    fetchSecrets();
  }, [selectedPod]);

  // Force re-render every 10 seconds to update ages
  useEffect(() => {
    const interval = setInterval(() => {
      forceUpdate({});
    }, 10000); // Update every 10 seconds

    return () => clearInterval(interval);
  }, []);

  // Clean up selected rows when pods are removed from data
  useEffect(() => {
    if (!data || data.length === 0) {
      setSelectedRows([]);
      return;
    }

    const currentKeys = new Set(data.map(pod => `${pod.namespace}/${pod.name}`));
    setSelectedRows(prev => prev.filter(key => currentKeys.has(key)));
  }, [data]);

  useEffect(() => {
    if (!data || data.length === 0) {
      setSelectedPod(null);
      return;
    }

    if (!selectedPod) {
      return; // Don't auto-select first pod
    }

    const updatedSelected = data.find((item) => item.name === selectedPod.name && item.namespace === selectedPod.namespace);
    if (!updatedSelected) {
      setSelectedPod(null); // Clear selection if pod was deleted
    } else {
      setSelectedPod(updatedSelected); // Update with fresh data
    }
  }, [data, selectedPod]);

  const columns = [
    {
      header: 'Name',
      accessor: (row: Pod) => (
        <span className="font-medium text-text">{row.name}</span>
      ),
      width: '16%',
      sortable: true,
      sortKey: 'name',
    },
    {
      header: 'Namespace',
      accessor: 'namespace' as const,
      width: '11%',
      sortable: true,
      sortKey: 'namespace',
    },
    {
      header: 'Status',
      accessor: (row: Pod) => (
        <span className="whitespace-nowrap">
          <StatusBadge status={row.status || row.phase || 'Unknown'} />
        </span>
      ),
      width: '8%',
      sortable: true,
      sortKey: 'status',
    },
    {
      header: 'Ready',
      accessor: (row: Pod) => <span className="whitespace-nowrap">{row.ready || '-'}</span>,
      width: '7%',
      sortable: true,
      sortKey: 'ready',
    },
    {
      header: 'Restarts',
      accessor: (row: Pod) => <span className="whitespace-nowrap">{row.restarts ?? 0}</span>,
      width: '7%',
      sortable: true,
      sortKey: 'restarts',
    },
    {
      header: 'CPU (cores)',
      accessor: (row: Pod) => (row.cpu != null && row.cpu !== '' && row.cpu !== '-' ? formatCpuCores(parseCpuToCores(String(row.cpu))) : '-'),
      width: '11%',
      sortable: true,
      sortKey: 'cpu',
    },
    {
      header: 'MEMORY(GB)',
      accessor: (row: Pod) => formatPodMemoryGb(row.memory),
      width: '11%',
      sortable: true,
      sortKey: 'memory',
    },
    {
      header: 'Node',
      accessor: (row: Pod) => <span className="whitespace-nowrap">{row.node || '-'}</span>,
      width: '11%',
      sortable: true,
      sortKey: 'node',
    },
    {
      header: 'Controlled By',
      accessor: (row: Pod) => (
        <span className="whitespace-nowrap">{row.controlled_by || '-'}</span>
      ),
      width: '18%',
      sortable: true,
      sortKey: 'controlled_by',
    },
    {
      header: 'QoS',
      accessor: (row: Pod) => row.qos || '-',
      width: '14%',
      sortable: true,
      sortKey: 'qos',
    },
    {
      header: 'Age',
      accessor: (row: Pod) => timeAgo(row.age),
      width: '15%',
      sortable: true,
      sortKey: 'age',
    },
  ];

  const sortedPods = useMemo((): (Pod & { id: string })[] => {
    let source = [...(data || [])];
    
    // Filter by selected namespaces (if any are selected)
    if (selectedNamespaces.length > 0) {
      source = source.filter((pod) => selectedNamespaces.includes(pod.namespace));
    }
    if (resourceNameFilter.trim()) {
      source = source.filter((pod) => matchesResourceNameFilter(pod.name, resourceNameFilter));
    }
    
    // Add unique id for row selection
    source = source.map((pod) => ({
      ...pod,
      id: `${pod.namespace}/${pod.name}`,
    })) as (Pod & { id: string })[];
    
    const factor = sortState.direction === 'asc' ? 1 : -1;

    return source.sort((first, second) => {
      const firstStatus = first.status || first.phase || '';
      const secondStatus = second.status || second.phase || '';

      if (sortState.key === 'name') return first.name.localeCompare(second.name) * factor;
      if (sortState.key === 'namespace') return first.namespace.localeCompare(second.namespace) * factor;
      if (sortState.key === 'node') return (first.node || '').localeCompare(second.node || '') * factor;
      if (sortState.key === 'status') return firstStatus.localeCompare(secondStatus) * factor;
      if (sortState.key === 'ready') return (first.ready || '').localeCompare(second.ready || '') * factor;
      if (sortState.key === 'restarts') return ((first.restarts ?? 0) - (second.restarts ?? 0)) * factor;
      if (sortState.key === 'cpu') {
        return (first.cpu || '').localeCompare(second.cpu || '', undefined, { numeric: true, sensitivity: 'base' }) * factor;
      }
      if (sortState.key === 'memory') {
        return (parseK8sQuantityToBytes(first.memory) - parseK8sQuantityToBytes(second.memory)) * factor;
      }
      if (sortState.key === 'controlled_by') return (first.controlled_by || '').localeCompare(second.controlled_by || '') * factor;
      if (sortState.key === 'qos') return (first.qos || '').localeCompare(second.qos || '') * factor;
      
      if (sortState.key === 'age') {
        const firstAge = Date.parse(first.age || '');
        const secondAge = Date.parse(second.age || '');
        return ((Number.isNaN(firstAge) ? 0 : firstAge) - (Number.isNaN(secondAge) ? 0 : secondAge)) * factor;
      }

      return 0;
    }) as (Pod & { id: string })[];
  }, [data, sortState, selectedNamespaces, resourceNameFilter]);

  const selectedPodWithEvents = useMemo(() => {
    if (!selectedPod) return null;

    const podEvents = (eventsData || [])
      .filter((event) => event.namespace === selectedPod.namespace && event.involved_object === `Pod/${selectedPod.name}`)
      .sort((a, b) => {
        const aTs = Date.parse(a.last_timestamp || a.first_timestamp || '');
        const bTs = Date.parse(b.last_timestamp || b.first_timestamp || '');
        return (Number.isNaN(bTs) ? 0 : bTs) - (Number.isNaN(aTs) ? 0 : aTs);
      })
      .map((event) => ({
        type: event.type,
        reason: event.reason,
        message: event.message,
        count: event.count,
        age: timeAgo(event.last_timestamp || event.first_timestamp || ''),
      }));

    const containersWithDecodedSecrets = selectedPod.containers?.map((container) => ({
      ...container,
      environment_variables: container.environment_variables?.map((env) => {
        if (env.source === 'secret' && env.value) {
          const idx = env.value.lastIndexOf('/');
          if (idx > 0) {
            const secretName = env.value.substring(0, idx);
            const keyName = env.value.substring(idx + 1);
            const key = `${selectedPod.namespace}/${secretName}`;
            const secretData = decodedSecrets[key];
            if (secretData && keyName && secretData[keyName] != null) {
              return { ...env, decoded_value: secretData[keyName] };
            }
          }
        }
        return env;
      }),
    })) || [];

    return {
      ...selectedPod,
      containers: containersWithDecodedSecrets,
      events: podEvents,
    };
  }, [selectedPod, eventsData, decodedSecrets]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Pods <span className="text-base font-normal text-text-secondary">(Real-time pod monitoring)</span></h1>
      </div>

      <div className="space-y-2">
        <DataTable
          columns={columns}
          data={sortedPods}
          isLoading={isLoading}
          error={error || undefined}
          rowKey="id"
          onRowClick={(row) => {
            setSelectedPod(row);
            setPanelOpen(true);
          }}
          selectedRowKey={panelOpen && selectedPod ? `${selectedPod.namespace}/${selectedPod.name}` : undefined}
          sortState={sortState}
          onSortChange={(nextSort) => setSortState(nextSort as { key: PodSortKey; direction: 'asc' | 'desc' })}
          enableRowSelection={true}
          selectedRows={selectedRows}
          onRowSelectionChange={(rows) => setSelectedRows(rows)}
        />
      </div>

      {panelOpen && selectedPodWithEvents && (
        <>
          <div
            className="fixed inset-0 z-[95] bg-black/20"
            onClick={() => setPanelOpen(false)}
          />
          <PodDetailPanel
            pod={selectedPodWithEvents}
            onClose={() => setPanelOpen(false)}
            onOpenYamlEditor={handleOpenYamlTab}
            onOpenShell={handleOpenShellTab}
            onOpenLogs={handleOpenLogsTab}
            onDelete={handleDeleteSingle}
          />
        </>
      )}

      {selectedRows.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[110] flex items-center gap-3 px-4 py-3 bg-surface border-2 border-violet-500 rounded-xl shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200">
          <span className="text-sm text-text-secondary font-medium">
            {selectedRows.length} selected
          </span>
          <div className="w-px h-4 bg-border" />
          <button
            type="button"
            onClick={handleDeleteSelected}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-[var(--color-icon-danger)]/10 text-[var(--color-icon-danger)] hover:bg-[var(--color-icon-danger)]/20 font-medium transition-colors"
          >
            <Trash2 size={14} />
            Delete
          </button>
          <button
            type="button"
            onClick={() => setSelectedRows([])}
            className="text-xs text-text-secondary hover:text-text transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.label ?? ''}`}
        description={
          confirmDelete && confirmDelete.keys.length === 1
            ? `Are you sure you want to delete "${confirmDelete.label}"? This action cannot be undone.`
            : `Are you sure you want to delete ${confirmDelete?.keys.length} pods? This action cannot be undone.`
        }
        confirmLabel="Delete"
        destructive
        isLoading={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
};
