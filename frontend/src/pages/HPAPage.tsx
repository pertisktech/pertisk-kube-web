import { useEffect, useMemo, useState } from 'react';
import YAML from 'yaml';
import { Trash2 } from '../components/Icons';
import { useRealtimeHPA } from '../hooks/useRealtimeResources';
import { deleteHPA } from '../hooks/useKubernetes';
import { useNamespace } from '../context/NamespaceContext';
import { DataTable, HPADetailPanel, ConfirmDialog } from '../components';
import type { HPA } from '../types';
import { getAuthToken } from '../utils/auth';
import { timeAgo, matchesResourceNameFilter } from '../utils';
import { openPanelTab } from '../components/BottomPanel';

type HPASortKey = 'name' | 'namespace' | 'reference' | 'current_replicas' | 'targets' | 'desired_replicas' | 'status' | 'age';

const getHpaStatus = (hpa: HPA): 'Scaling Up' | 'Scaling Down' | 'Stable' => {
  if ((hpa.desired_replicas ?? 0) > (hpa.current_replicas ?? 0)) return 'Scaling Up';
  if ((hpa.desired_replicas ?? 0) < (hpa.current_replicas ?? 0)) return 'Scaling Down';
  return 'Stable';
};

const sanitizeHPAYamlForEdit = (yamlText: string) => {
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

export const HPAPage = () => {
  const { data, isLoading, error } = useRealtimeHPA();
  const { selectedNamespaces, resourceNameFilter } = useNamespace();
  const [selectedHPA, setSelectedHPA] = useState<HPA | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: HPASortKey; direction: 'asc' | 'desc' }>({
    key: 'age',
    direction: 'desc',
  });
    
  
  useEffect(() => {
    if (!data || data.length === 0) {
      setSelectedHPA(null);
      return;
    }

    if (!selectedHPA) {
      setSelectedHPA(data[0]);
      return;
    }

    const updatedSelected = data.find(
      (item) => item.name === selectedHPA.name && item.namespace === selectedHPA.namespace
    );
    setSelectedHPA(updatedSelected ?? data[0]);
  }, [data]);
  
  
  

  const handleOpenYamlEditorFromPanel = async (hpa: HPA) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/hpa/${encodeURIComponent(hpa.namespace)}/${encodeURIComponent(hpa.name)}/yaml`, {
        headers: token ? { Authorization: token } : {},
      });
      if (!res.ok) throw new Error(`Failed to load YAML: ${res.statusText}`);
      const yaml = await res.text();
      openPanelTab({ type: 'yaml-editor', yamlContent: sanitizeHPAYamlForEdit(yaml), title: hpa.name });
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
      label: selectedRows.length === 1 ? selectedRows[0].split('/')[1] : `${selectedRows.length} hpas`,
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try {
      await Promise.all(
        confirmDelete.keys.map((key) => {
          const [ns, name] = key.split('/');
          return deleteHPA(ns, name);
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
      accessor: (hpa: HPA) => <span className="font-medium text-text">{hpa.name}</span>,
      width: '20%',
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
      header: 'Reference',
      accessor: (hpa: HPA) => (
        <span className="text-text-secondary text-sm">{hpa.reference || '-'}</span>
      ),
      width: '15%',
      sortable: true,
      sortKey: 'reference',
    },
    {
      header: 'Current / Min-Max',
      accessor: (hpa: HPA) => (
        <span className="text-text-secondary">
          {hpa.current_replicas} / {hpa.min_replicas}-{hpa.max_replicas}
        </span>
      ),
      width: '20%',
      sortable: true,
      sortKey: 'current_replicas',
    },
    {
      header: 'Targets',
      accessor: 'targets' as const,
      width: '15%',
      sortable: true,
      sortKey: 'targets',
    },
    {
      header: 'Replicas',
      accessor: (hpa: HPA) => (
        <span className="text-text-secondary">
          {hpa.current_replicas} / {hpa.desired_replicas}
        </span>
      ),
      width: '12%',
      sortable: true,
      sortKey: 'desired_replicas',
    },
    {
      header: 'Status',
      accessor: (hpa: HPA) => {
        const status = getHpaStatus(hpa);
        const statusClass = status === 'Stable' ? 'status-green' : 'status-yellow';
        return (
          <span className={`inline-flex items-center whitespace-nowrap px-2.5 py-0.5 rounded-full text-xs font-medium ${statusClass}`}>
            {status}
          </span>
        );
      },
      width: '13%',
      sortable: true,
      sortKey: 'status',
    },
    {
      header: 'Age',
      accessor: (hpa: HPA) => timeAgo(hpa.age),
      width: '15%',
      sortable: true,
      sortKey: 'age',
    },
  ];

  const sortedHPAs = useMemo((): (HPA & { id: string })[] => {
    let source = [...(data || [])];

    if (selectedNamespaces.length > 0) {
      source = source.filter((h) => selectedNamespaces.includes(h.namespace));
    }
    if (resourceNameFilter.trim()) {
      source = source.filter((h) => matchesResourceNameFilter(h.name, resourceNameFilter));
    }

    const sourceWithId = source.map((item) => ({
      ...item,
      id: `${item.namespace}/${item.name}`,
    }));

    const factor = sortState.direction === 'asc' ? 1 : -1;

    return sourceWithId.sort((first, second) => {
      if (sortState.key === 'name') return first.name.localeCompare(second.name) * factor;
      if (sortState.key === 'namespace') return first.namespace.localeCompare(second.namespace) * factor;
      if (sortState.key === 'reference') return (first.reference || '').localeCompare(second.reference || '') * factor;
      if (sortState.key === 'current_replicas') return ((first.current_replicas ?? 0) - (second.current_replicas ?? 0)) * factor;
      if (sortState.key === 'targets') return ((first.targets ?? 0) - (second.targets ?? 0)) * factor;
      if (sortState.key === 'desired_replicas') return ((first.desired_replicas ?? 0) - (second.desired_replicas ?? 0)) * factor;
      if (sortState.key === 'status') return getHpaStatus(first).localeCompare(getHpaStatus(second)) * factor;

      const firstAge = Date.parse(first.age || '');
      const secondAge = Date.parse(second.age || '');
      return ((Number.isNaN(firstAge) ? 0 : firstAge) - (Number.isNaN(secondAge) ? 0 : secondAge)) * factor;
    });
  }, [data, sortState, selectedNamespaces, resourceNameFilter]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">HPA <span className="text-base font-normal text-text-secondary">(Manage Horizontal Pod Autoscalers)</span></h1>
      </div>

      <div
        className="space-y-2"
      >
        <DataTable
          columns={columns}
          data={sortedHPAs}
          isLoading={isLoading}
          error={error}
          rowKey="id"
          onRowClick={(row) => {
            setSelectedHPA(row);
            setPanelOpen(true);
          }}
          selectedRowKey={
            panelOpen && selectedHPA
              ? `${selectedHPA.namespace}/${selectedHPA.name}`
              : undefined
          }
          sortState={sortState}
          onSortChange={(nextSort) =>
            setSortState(nextSort as { key: HPASortKey; direction: 'asc' | 'desc' })
          }
          enableRowSelection={true}
          selectedRows={selectedRows}
          onRowSelectionChange={(rows) => setSelectedRows(rows)}
        />

        </div>

      {panelOpen && selectedHPA && (
        <>
          <div className="fixed inset-0 z-[95] bg-black/20" onClick={() => setPanelOpen(false)} />
          <HPADetailPanel
            hpa={selectedHPA}
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
            : `Are you sure you want to delete ${confirmDelete?.keys.length} hpas? This action cannot be undone.`
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
