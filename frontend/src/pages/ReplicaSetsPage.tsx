import { useEffect, useMemo, useState } from 'react';
import YAML from 'yaml';
import { Trash2 } from '../components/Icons';
import { useRealtimeReplicaSets } from '../hooks/useRealtimeResources';
import { useNamespace } from '../context/NamespaceContext';
import { DataTable, ReplicaSetDetailPanel, ConfirmDialog } from '../components';
import { StatusBadge } from '../components/StatusBadge';
import type { ReplicaSet } from '../types';
import { getAuthToken } from '../utils/auth';
import { timeAgo, matchesResourceNameFilter } from '../utils';
import { deleteReplicaSet } from '../hooks/useKubernetes';
import { openPanelTab } from '../components/BottomPanel';

type ReplicaSetSortKey =
  | 'name'
  | 'namespace'
  | 'status'
  | 'desired'
  | 'current'
  | 'ready'
  | 'available'
  | 'age';

const sanitizeReplicaSetYamlForEdit = (yamlText: string) => {
  try {
    const parsed = YAML.parse(yamlText) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') {
      return yamlText;
    }

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
        if (Object.keys(annotations).length === 0) {
          delete metadata.annotations;
        }
      }
    }

    delete parsed.status;

    return YAML.stringify(parsed, { lineWidth: 0 });
  } catch {
    return yamlText;
  }
};

export const ReplicaSetsPage = () => {
  const { data, isLoading, error } = useRealtimeReplicaSets();
  const { selectedNamespaces, resourceNameFilter } = useNamespace();
  const [selectedReplicaSet, setSelectedReplicaSet] = useState<ReplicaSet | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: ReplicaSetSortKey; direction: 'asc' | 'desc' }>({
    key: 'age',
    direction: 'desc',
  });

  useEffect(() => {
    if (!data || data.length === 0) {
      setSelectedReplicaSet(null);
      return;
    }

    if (!selectedReplicaSet) {
      setSelectedReplicaSet(data[0]);
      return;
    }

    const updatedSelected = data.find(
      (item) => item.name === selectedReplicaSet.name && item.namespace === selectedReplicaSet.namespace
    );
    setSelectedReplicaSet(updatedSelected ?? data[0]);
  }, [data]);


  const handleOpenYamlEditorFromPanel = async (replicaSet: ReplicaSet) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/replicasets/${encodeURIComponent(replicaSet.namespace)}/${encodeURIComponent(replicaSet.name)}/yaml`, {
        headers: token ? { Authorization: token } : {},
      });
      if (!res.ok) throw new Error(`Failed to load YAML: ${res.statusText}`);
      const yaml = await res.text();
      openPanelTab({ type: 'yaml-editor', yamlContent: sanitizeReplicaSetYamlForEdit(yaml), title: replicaSet.name });
    } catch {
      openPanelTab({ type: 'yaml-editor' });
    }
  };


  const handleDeleteSingle = async (namespace: string, name: string) => {
    setConfirmDelete({ keys: [`${namespace}/${name}`], label: name });
    setPanelOpen(false);
  };

  const handleDeleteSelected = () => {
    if (selectedRows.length === 0) return;
    setConfirmDelete({
      keys: selectedRows,
      label: selectedRows.length === 1 ? selectedRows[0].split('/')[1] : `${selectedRows.length} replicasets`,
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try {
      await Promise.all(
        confirmDelete.keys.map((key) => {
          const [ns, name] = key.split('/');
          return deleteReplicaSet(ns, name);
        })
      );
      setSelectedRows([]);
      setConfirmDelete(null);
    } finally {
      setIsDeleting(false);
    }
  };

  const columns = [
    {
      header: 'Name',
      accessor: (row: ReplicaSet) => <span className="font-medium text-text">{row.name}</span>,
      width: '25%',
      sortable: true,
      sortKey: 'name',
    },
    {
      header: 'Namespace',
      accessor: 'namespace' as const,
      width: '15%',
      sortable: true,
      sortKey: 'namespace',
    },
    {
      header: 'Status',
      accessor: (row: ReplicaSet) => <StatusBadge status={row.status || 'Unknown'} />,
      width: '10%',
      sortable: true,
      sortKey: 'status',
    },
    {
      header: 'Desired',
      accessor: 'desired' as const,
      width: '10%',
      sortable: true,
      sortKey: 'desired',
    },
    {
      header: 'Current',
      accessor: 'current' as const,
      width: '10%',
      sortable: true,
      sortKey: 'current',
    },
    {
      header: 'Ready',
      accessor: 'ready' as const,
      width: '10%',
      sortable: true,
      sortKey: 'ready',
    },
    {
      header: 'Available',
      accessor: 'available' as const,
      width: '10%',
      sortable: true,
      sortKey: 'available',
    },
    {
      header: 'Age',
      accessor: (row: ReplicaSet) => timeAgo(row.age),
      width: '10%',
      sortable: true,
      sortKey: 'age',
    },
  ];

  const sortedReplicaSets = useMemo((): (ReplicaSet & { id: string })[] => {
    let source = [...(data || [])];
    
    // Filter by selected namespaces (if any are selected)
if (selectedNamespaces.length > 0) {
      source = source.filter((replicaSet) => selectedNamespaces.includes(replicaSet.namespace));
    }
    if (resourceNameFilter.trim()) {
      source = source.filter((r) => matchesResourceNameFilter(r.name, resourceNameFilter));
    }

    // Add unique id for row selection
    const sourceWithId = source.map((item) => ({
      ...item,
      id: `${item.namespace}/${item.name}`,
    }));
    
    const factor = sortState.direction === 'asc' ? 1 : -1;

    return sourceWithId.sort((first, second) => {
      if (sortState.key === 'name') return first.name.localeCompare(second.name) * factor;
      if (sortState.key === 'namespace') return first.namespace.localeCompare(second.namespace) * factor;
      if (sortState.key === 'status') return (first.status || '').localeCompare(second.status || '') * factor;
      if (sortState.key === 'desired') return ((first.desired ?? 0) - (second.desired ?? 0)) * factor;
      if (sortState.key === 'current') return ((first.current ?? 0) - (second.current ?? 0)) * factor;
      if (sortState.key === 'ready') return ((first.ready ?? 0) - (second.ready ?? 0)) * factor;
      if (sortState.key === 'available') return ((first.available ?? 0) - (second.available ?? 0)) * factor;

      const firstAge = Date.parse(first.age || '');
      const secondAge = Date.parse(second.age || '');
      return ((Number.isNaN(firstAge) ? 0 : firstAge) - (Number.isNaN(secondAge) ? 0 : secondAge)) * factor;
    });
  }, [data, sortState, selectedNamespaces, resourceNameFilter]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">ReplicaSets <span className="text-base font-normal text-text-secondary">(Manage ReplicaSet resources)</span></h1>
      </div>

      <div
        className="space-y-2"
      >
        <DataTable
        columns={columns}
        data={sortedReplicaSets}
        isLoading={isLoading}
        error={error}
        rowKey="id"
        onRowClick={(row) => {
          setSelectedReplicaSet(row);
          setPanelOpen(true);
        }}
        selectedRowKey={panelOpen && selectedReplicaSet ? `${selectedReplicaSet.namespace}/${selectedReplicaSet.name}` : undefined}
        sortState={sortState}
        onSortChange={(nextSort) => setSortState(nextSort as { key: ReplicaSetSortKey; direction: 'asc' | 'desc' })}
        enableRowSelection={true}
        selectedRows={selectedRows}
        onRowSelectionChange={(rows) => setSelectedRows(rows)}
      />

        </div>

      {panelOpen && selectedReplicaSet && (
        <>
          <div
            className="fixed inset-0 z-[95] bg-black/20"
            onClick={() => setPanelOpen(false)}
          />
          <ReplicaSetDetailPanel
            replicaSet={selectedReplicaSet}
            onClose={() => setPanelOpen(false)}
            onOpenYamlEditor={handleOpenYamlEditorFromPanel}
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
            : `Are you sure you want to delete ${confirmDelete?.keys.length} replicasets? This action cannot be undone.`
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
