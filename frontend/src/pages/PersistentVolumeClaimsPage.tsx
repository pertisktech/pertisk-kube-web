import { useMemo, useState } from 'react';
import YAML from 'yaml';
import { Trash2 } from '../components/Icons';
import { useRealtimePersistentVolumeClaims } from '../hooks/useRealtimeResources';
import { useRealtimePods } from '../hooks/useRealtimePods';
import { deletePersistentVolumeClaim } from '../hooks/useKubernetes';
import { useNamespace } from '../context/NamespaceContext';
import { DataTable, PVCDetailPanel, ConfirmDialog } from '../components';
import type { PersistentVolumeClaim, Pod } from '../types';
import { getAuthToken } from '../utils/auth';
import { timeAgo, matchesResourceNameFilter } from '../utils';
import { StatusBadge } from '../components/StatusBadge';
import { openPanelTab } from '../components/BottomPanel';

type PVCSortKey = 'name' | 'namespace' | 'volume' | 'capacity' | 'age';

const sanitizeYamlForEdit = (yamlText: string) => {
  try {
    const parsed = YAML.parse(yamlText) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return yamlText;
    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    if (metadata) {
      delete metadata.managedFields; delete metadata.resourceVersion; delete metadata.uid;
      delete metadata.generation; delete metadata.creationTimestamp; delete metadata.selfLink;
      const annotations = metadata.annotations as Record<string, unknown> | undefined;
      if (annotations) { delete annotations['kubectl.kubernetes.io/last-applied-configuration']; if (Object.keys(annotations).length === 0) delete metadata.annotations; }
    }
    delete parsed.status;
    return YAML.stringify(parsed, { lineWidth: 0 });
  } catch { return yamlText; }
};

export const PersistentVolumeClaimsPage = () => {
  const { data, isLoading, error } = useRealtimePersistentVolumeClaims();
  const { data: podsData = [] } = useRealtimePods<Pod>();
  const { selectedNamespaces, resourceNameFilter } = useNamespace();
  const [selectedItem, setSelectedItem] = useState<PersistentVolumeClaim | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: PVCSortKey; direction: 'asc' | 'desc' }>({ key: 'age', direction: 'desc' });


  const handleDeleteSingle = async (namespace: string, name: string) => {
    const key = `${namespace}/${name}`;
    setConfirmDelete({ keys: [key], label: name }); setPanelOpen(false);
  };
  const handleDeleteSelected = () => { if (!selectedRows.length) return; setConfirmDelete({ keys: selectedRows, label: selectedRows.length === 1 ? selectedRows[0].split('/')[1] : `${selectedRows.length} PVCs` }); };
  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try {
      await Promise.all(confirmDelete.keys.map((key) => {
        const [ns, ...rest] = key.split('/');
        return deletePersistentVolumeClaim(ns, rest.join('/'));
      }));
      setSelectedRows([]); setConfirmDelete(null);
    } finally { setIsDeleting(false); }
  };

  const pvcPodMap = useMemo(() => {
    const map = new Map<string, string[]>();

    for (const pod of podsData) {
      const podName = pod.name || '-';
      const podNamespace = pod.namespace || 'default';
      const volumes = pod.volumes || [];

      for (const vol of volumes) {
        if (vol?.type !== 'persistentVolumeClaim') continue;
        const claimName = vol.source;
        if (!claimName || claimName === '-') continue;

        const key = `${podNamespace}/${claimName}`;
        const list = map.get(key) || [];
        if (!list.includes(podName)) {
          list.push(podName);
          map.set(key, list);
        }
      }
    }

    return map;
  }, [podsData]);

  const columns = [
    { header: 'Name', accessor: 'name' as const, width: '18%', sortable: true, sortKey: 'name' },
    { header: 'Namespace', accessor: 'namespace' as const, width: '13%', sortable: true, sortKey: 'namespace' },
    {
      header: 'Status',
      accessor: (pvc: PersistentVolumeClaim) => <StatusBadge status={pvc.status} />,
      width: '10%',
    },
    { header: 'Volume', accessor: 'volume' as const, width: '18%', sortable: true, sortKey: 'volume' },
    { header: 'Capacity', accessor: 'capacity' as const, width: '10%', sortable: true, sortKey: 'capacity' },
    {
      header: 'Pods',
      accessor: (pvc: PersistentVolumeClaim) => {
        const key = `${pvc.namespace}/${pvc.name}`;
        const podNames = pvcPodMap.get(key) || [];
        return podNames.length > 0 ? podNames.join(', ') : '-';
      },
      width: '12%',
    },
    { header: 'Storage Class', accessor: 'storage_class' as const, width: '12%' },
    { header: 'Age', accessor: (pvc: PersistentVolumeClaim) => timeAgo(pvc.age), width: '10%', sortable: true, sortKey: 'age' },
  ];

  const sortedData = useMemo(() => {
    let source = data || [];
    if (selectedNamespaces.length > 0) source = source.filter((p) => selectedNamespaces.includes(p.namespace));
    if (resourceNameFilter.trim()) source = source.filter((p) => matchesResourceNameFilter(p.name, resourceNameFilter));
    const withId = source.map((p) => ({ ...p, id: `${p.namespace}/${p.name}` }));
    const f = sortState.direction === 'asc' ? 1 : -1;
    return withId.sort((a, b) => {
      if (sortState.key === 'name') return a.name.localeCompare(b.name) * f;
      if (sortState.key === 'namespace') return a.namespace.localeCompare(b.namespace) * f;
      if (sortState.key === 'volume') return (a.volume || '').localeCompare(b.volume || '') * f;
      if (sortState.key === 'capacity') return (a.capacity || '').localeCompare(b.capacity || '') * f;
      const at = Date.parse(a.age || ''); const bt = Date.parse(b.age || '');
      return ((Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt)) * f;
    });
  }, [data, sortState, selectedNamespaces, resourceNameFilter]);


  const handleOpenYamlEditorFromPanel = async (item: PersistentVolumeClaim) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/persistentvolumeclaims/${encodeURIComponent(item.namespace)}/${encodeURIComponent(item.name)}/yaml`, {
        headers: token ? { Authorization: token } : {},
      });
      if (!res.ok) throw new Error(`Failed to load YAML: ${res.statusText}`);
      const yaml = await res.text();
      openPanelTab({ type: 'yaml-editor', yamlContent: sanitizeYamlForEdit(yaml), title: item.name });
    } catch {
      openPanelTab({ type: 'yaml-editor' });
    }
  };
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Persistent Volume Claims <span className="text-base font-normal text-text-secondary">(Manage PersistentVolumeClaim resources in your namespaces.)</span></h1>
      </div>

      <div className="space-y-2">
        <DataTable
          columns={columns} data={sortedData} isLoading={isLoading} error={error} rowKey="id"
          onRowClick={(row) => { setSelectedItem(row); setPanelOpen(true); }}
          selectedRowKey={panelOpen && selectedItem ? `${selectedItem.namespace}/${selectedItem.name}` : undefined}
          sortState={sortState} onSortChange={(s) => setSortState(s as { key: PVCSortKey; direction: 'asc' | 'desc' })}
          enableRowSelection={true} selectedRows={selectedRows} onRowSelectionChange={setSelectedRows}
        />

        </div>

      {panelOpen && selectedItem && (
        <>
          <div className="fixed inset-0 z-[95] bg-black/20" onClick={() => setPanelOpen(false)} />
          <PVCDetailPanel pvc={selectedItem} onClose={() => setPanelOpen(false)} onOpenYamlEditor={handleOpenYamlEditorFromPanel} onDelete={handleDeleteSingle} />
        </>
      )}

      {selectedRows.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[110] flex items-center gap-3 px-4 py-3 bg-surface border-2 border-violet-500 rounded-xl shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200">
          <span className="text-sm text-text-secondary font-medium">{selectedRows.length} selected</span>
          <div className="w-px h-4 bg-border" />
          <button type="button" onClick={handleDeleteSelected} className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-[var(--color-icon-danger)]/10 text-[var(--color-icon-danger)] hover:bg-[var(--color-icon-danger)]/20 font-medium transition-colors"><Trash2 size={14} />Delete</button>
          <button type="button" onClick={() => setSelectedRows([])} className="text-xs text-text-secondary hover:text-text transition-colors">Clear</button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.label ?? ''}`}
        description={confirmDelete?.keys.length === 1 ? `Are you sure you want to delete "${confirmDelete?.label}"? This action cannot be undone.` : `Are you sure you want to delete ${confirmDelete?.keys.length} PVCs? This action cannot be undone.`}
        confirmLabel="Delete" destructive isLoading={isDeleting} onConfirm={handleConfirmDelete} onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
};
