import { useMemo, useState } from 'react';
import YAML from 'yaml';
import { Trash2 } from '../components/Icons';
import { useRealtimeStorageClasses } from '../hooks/useRealtimeResources';
import { deleteStorageClass } from '../hooks/useKubernetes';
import { DataTable, StorageClassDetailPanel, ConfirmDialog } from '../components';
import type { StorageClass } from '../types';
import { getAuthToken } from '../utils/auth';
import { timeAgo } from '../utils';
import { StatusBadge } from '../components/StatusBadge';
import { openPanelTab } from '../components/BottomPanel';

type StorageClassSortKey = 'name' | 'provisioner' | 'reclaim_policy' | 'volume_binding_mode' | 'age';

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

export const StorageClassesPage = () => {
  const { data, isLoading, error } = useRealtimeStorageClasses();
  const [selectedItem, setSelectedItem] = useState<StorageClass | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: StorageClassSortKey; direction: 'asc' | 'desc' }>({ key: 'age', direction: 'desc' });


  const handleDeleteSingle = async (name: string) => { setConfirmDelete({ keys: [name], label: name }); setPanelOpen(false); };
  const handleDeleteSelected = () => { if (!selectedRows.length) return; setConfirmDelete({ keys: selectedRows, label: selectedRows.length === 1 ? selectedRows[0] : `${selectedRows.length} storage classes` }); };
  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try { await Promise.all(confirmDelete.keys.map((name) => deleteStorageClass(name))); setSelectedRows([]); setConfirmDelete(null); }
    finally { setIsDeleting(false); }
  };

  const columns = [
    {
      header: 'Name',
      accessor: (row: StorageClass) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-text">{row.name}</span>
          {row.is_default && <span className="inline-block px-2 py-0.5 rounded text-xs bg-green-100 text-green-800">Default</span>}
        </div>
      ),
      width: '20%', sortable: true, sortKey: 'name',
    },
    { header: 'Provisioner', accessor: 'provisioner' as const, width: '22%', sortable: true, sortKey: 'provisioner' },
    { header: 'Reclaim Policy', accessor: 'reclaim_policy' as const, width: '13%', sortable: true, sortKey: 'reclaim_policy' },
    { header: 'Binding Mode', accessor: 'volume_binding_mode' as const, width: '15%', sortable: true, sortKey: 'volume_binding_mode' },
    {
      header: 'Expansion', accessor: 'allow_volume_expansion' as const, width: '11%',
      render: (sc: StorageClass) => <StatusBadge status={sc.allow_volume_expansion ? 'Yes' : 'No'} />,
    },
    { header: 'Age', accessor: (sc: StorageClass) => timeAgo(sc.age), width: '10%', sortable: true, sortKey: 'age' },
  ];

  const sortedData = useMemo(() => {
    const withId = (data || []).map((sc) => ({ ...sc, id: sc.name }));
    const f = sortState.direction === 'asc' ? 1 : -1;
    return withId.sort((a, b) => {
      if (sortState.key === 'name') return a.name.localeCompare(b.name) * f;
      if (sortState.key === 'provisioner') return (a.provisioner || '').localeCompare(b.provisioner || '') * f;
      if (sortState.key === 'reclaim_policy') return (a.reclaim_policy || '').localeCompare(b.reclaim_policy || '') * f;
      if (sortState.key === 'volume_binding_mode') return (a.volume_binding_mode || '').localeCompare(b.volume_binding_mode || '') * f;
      const at = Date.parse(a.age || ''); const bt = Date.parse(b.age || '');
      return ((Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt)) * f;
    });
  }, [data, sortState]);


  const handleOpenYamlEditorFromPanel = async (item: StorageClass) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/storageclasses/${encodeURIComponent(item.name)}/yaml`, {
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
        <h1 className="text-xl font-semibold text-text">Storage Classes <span className="text-base font-normal text-text-secondary">(Manage cluster-wide StorageClass resources.)</span></h1>
      </div>

      <div className="space-y-2">
        <DataTable
          columns={columns} data={sortedData} isLoading={isLoading} error={error} rowKey="id"
          onRowClick={(row) => { setSelectedItem(row); setPanelOpen(true); }}
          selectedRowKey={panelOpen && selectedItem ? selectedItem.name : undefined}
          sortState={sortState} onSortChange={(s) => setSortState(s as { key: StorageClassSortKey; direction: 'asc' | 'desc' })}
          enableRowSelection={true} selectedRows={selectedRows} onRowSelectionChange={setSelectedRows}
        />

        </div>

      {panelOpen && selectedItem && (
        <>
          <div className="fixed inset-0 z-[95] bg-black/20" onClick={() => setPanelOpen(false)} />
          <StorageClassDetailPanel storageClass={selectedItem} onClose={() => setPanelOpen(false)} onOpenYamlEditor={handleOpenYamlEditorFromPanel} onDelete={handleDeleteSingle} />
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
        description={confirmDelete?.keys.length === 1 ? `Are you sure you want to delete "${confirmDelete?.label}"? This action cannot be undone.` : `Are you sure you want to delete ${confirmDelete?.keys.length} storage classes? This action cannot be undone.`}
        confirmLabel="Delete" destructive isLoading={isDeleting} onConfirm={handleConfirmDelete} onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
};
