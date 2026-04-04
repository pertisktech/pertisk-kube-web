import { useEffect, useMemo, useState } from 'react';
import YAML from 'yaml';
import { Trash2 } from '../components/Icons';
import { useRealtimeStatefulSets } from '../hooks/useRealtimeResources';
import { useNamespace } from '../context/NamespaceContext';
import { DataTable, StatefulSetDetailPanel, ConfirmDialog } from '../components';
import { StatusBadge } from '../components/StatusBadge';
import type { StatefulSet } from '../types';
import { getAuthToken } from '../utils/auth';
import { timeAgo, matchesResourceNameFilter } from '../utils';
import { deleteStatefulSet } from '../hooks/useKubernetes';
import { openPanelTab } from '../components/BottomPanel';

type StatefulSetSortKey = 'name' | 'namespace' | 'status' | 'ready' | 'current' | 'updated' | 'age';

const sanitizeStatefulSetYamlForEdit = (yamlText: string) => {
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

export const StatefulSetsPage = () => {
  const { data, isLoading, error } = useRealtimeStatefulSets();
  const { selectedNamespaces, resourceNameFilter } = useNamespace();
  const [selectedStatefulSet, setSelectedStatefulSet] = useState<StatefulSet | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: StatefulSetSortKey; direction: 'asc' | 'desc' }>({
    key: 'age',
    direction: 'desc',
  });

  useEffect(() => {
    if (!data || data.length === 0) {
      setSelectedStatefulSet(null);
      return;
    }

    if (!selectedStatefulSet) {
      setSelectedStatefulSet(data[0]);
      return;
    }

    const updatedSelected = data.find(
      (item) => item.name === selectedStatefulSet.name && item.namespace === selectedStatefulSet.namespace
    );
    setSelectedStatefulSet(updatedSelected ?? data[0]);
  }, [data]);


  const handleOpenYamlEditorFromPanel = async (statefulSet: StatefulSet) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/statefulsets/${encodeURIComponent(statefulSet.namespace)}/${encodeURIComponent(statefulSet.name)}/yaml`, {
        headers: token ? { Authorization: token } : {},
      });
      if (!res.ok) throw new Error(`Failed to load YAML: ${res.statusText}`);
      const yaml = await res.text();
      openPanelTab({ type: 'yaml-editor', yamlContent: sanitizeStatefulSetYamlForEdit(yaml), title: statefulSet.name });
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
      label: selectedRows.length === 1 ? selectedRows[0].split('/')[1] : `${selectedRows.length} statefulsets`,
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try {
      await Promise.all(
        confirmDelete.keys.map((key) => {
          const [ns, name] = key.split('/');
          return deleteStatefulSet(ns, name);
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
      accessor: (row: StatefulSet) => <span className="font-medium text-text">{row.name}</span>,
      width: '22%',
      sortable: true,
      sortKey: 'name',
    },
    {
      header: 'Namespace',
      accessor: 'namespace' as const,
      width: '14%',
      sortable: true,
      sortKey: 'namespace',
    },
    {
      header: 'Status',
      accessor: (row: StatefulSet) => <StatusBadge status={row.status || 'Unknown'} />,
      width: '10%',
      sortable: true,
      sortKey: 'status',
    },
    {
      header: 'Ready',
      accessor: 'ready' as const,
      width: '10%',
      sortable: true,
      sortKey: 'ready',
    },
    {
      header: 'Current',
      accessor: 'current' as const,
      width: '10%',
      sortable: true,
      sortKey: 'current',
    },
    {
      header: 'Updated',
      accessor: 'updated' as const,
      width: '10%',
      sortable: true,
      sortKey: 'updated',
    },
    {
      header: 'Age',
      accessor: (row: StatefulSet) => timeAgo(row.age),
      width: '10%',
      sortable: true,
      sortKey: 'age',
    },
  ];

  const sortedStatefulSets = useMemo((): (StatefulSet & { id: string })[] => {
    let source = [...(data || [])];

    // Filter by selected namespaces (if any are selected)
    if (selectedNamespaces.length > 0) {
      source = source.filter((statefulSet) => selectedNamespaces.includes(statefulSet.namespace));
    }
    if (resourceNameFilter.trim()) {
      source = source.filter((s) => matchesResourceNameFilter(s.name, resourceNameFilter));
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
      if (sortState.key === 'ready') return (first.ready || '').localeCompare(second.ready || '') * factor;
      if (sortState.key === 'current') return ((first.current ?? 0) - (second.current ?? 0)) * factor;
      if (sortState.key === 'updated') return ((first.updated ?? 0) - (second.updated ?? 0)) * factor;

      const firstAge = Date.parse(first.age || '');
      const secondAge = Date.parse(second.age || '');
      return ((Number.isNaN(firstAge) ? 0 : firstAge) - (Number.isNaN(secondAge) ? 0 : secondAge)) * factor;
    });
  }, [data, sortState, selectedNamespaces, resourceNameFilter]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">StatefulSets <span className="text-base font-normal text-text-secondary">(Manage StatefulSet resources)</span></h1>
      </div>

      <div
        className="space-y-2"
      >
        <DataTable
          columns={columns}
          data={sortedStatefulSets}
          isLoading={isLoading}
          error={error}
          rowKey="id"
          onRowClick={(row) => {
            setSelectedStatefulSet(row);
            setPanelOpen(true);
          }}
          selectedRowKey={
            panelOpen && selectedStatefulSet
              ? `${selectedStatefulSet.namespace}/${selectedStatefulSet.name}`
              : undefined
          }
          sortState={sortState}
          onSortChange={(nextSort) =>
            setSortState(nextSort as { key: StatefulSetSortKey; direction: 'asc' | 'desc' })
          }
          enableRowSelection={true}
          selectedRows={selectedRows}
          onRowSelectionChange={(rows) => setSelectedRows(rows)}
        />

        </div>

      {panelOpen && selectedStatefulSet && (
        <>
          <div className="fixed inset-0 z-[95] bg-black/20" onClick={() => setPanelOpen(false)} />
          <StatefulSetDetailPanel
            statefulSet={selectedStatefulSet}
            onClose={() => setPanelOpen(false)}
            onOpenYamlEditor={handleOpenYamlEditorFromPanel}
            onDelete={handleDeleteSingle}
          />
        </>
      )}

      {selectedRows.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[110] flex items-center gap-3 px-4 py-3 bg-surface border-2 border-violet-500 rounded-xl shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200">
          <span className="text-sm text-text-secondary font-medium">{selectedRows.length} selected</span>
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
            : `Are you sure you want to delete ${confirmDelete?.keys.length} statefulsets? This action cannot be undone.`
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
