import { useMemo, useState } from 'react';
import YAML from 'yaml';
import { Trash2 } from '../components/Icons';
import { useRealtimeClusterRoles } from '../hooks/useRealtimeResources';
import { deleteClusterRole } from '../hooks/useKubernetes';
import { DataTable, ClusterRoleDetailPanel, ConfirmDialog } from '../components';
import type { ClusterRole } from '../types';
import { getAuthToken } from '../utils/auth';
import { timeAgo } from '../utils';
import { openPanelTab } from '../components/BottomPanel';

type ClusterRolesSortKey = 'name' | 'age';

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

export const ClusterRolesPage = () => {
  const { data, isLoading, error } = useRealtimeClusterRoles();
  const [selectedItem, setSelectedItem] = useState<ClusterRole | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: ClusterRolesSortKey; direction: 'asc' | 'desc' }>({ key: 'age', direction: 'desc' });


  const handleDeleteSingle = async (name: string) => { setConfirmDelete({ keys: [name], label: name }); setPanelOpen(false); };
  const handleDeleteSelected = () => { if (!selectedRows.length) return; setConfirmDelete({ keys: selectedRows, label: selectedRows.length === 1 ? selectedRows[0] : `${selectedRows.length} items` }); };
  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try { await Promise.all(confirmDelete.keys.map((name) => deleteClusterRole(name))); setSelectedRows([]); setConfirmDelete(null); }
    finally { setIsDeleting(false); }
  };

  const columns = [
    { header: 'Name', accessor: 'name' as const, width: '50%', sortable: true, sortKey: 'name' },
    { header: 'Rules', accessor: 'rules' as const, width: '25%' },
    { header: 'Age', accessor: (r: ClusterRole) => timeAgo(r.age), width: '25%', sortable: true, sortKey: 'age' },
  ];

  const sortedData = useMemo(() => {
    const withId = (data || []).map((r) => ({ ...r, id: r.name }));
    const f = sortState.direction === 'asc' ? 1 : -1;
    return withId.sort((a, b) => {
      if (sortState.key === 'name') return a.name.localeCompare(b.name) * f;
      const at = Date.parse((a as any).age || ''); const bt = Date.parse((b as any).age || '');
      return ((Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt)) * f;
    });
  }, [data, sortState]);


  const handleOpenYamlEditorFromPanel = async (item: ClusterRole) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/clusterroles/${encodeURIComponent(item.name)}/yaml`, {
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
        <h1 className="text-xl font-semibold text-text">Cluster Roles <span className="text-base font-normal text-text-secondary">(Cluster-wide RBAC roles defining permissions across all namespaces.)</span></h1>
      </div>

      <div className="space-y-2">
        <DataTable
          columns={columns} data={sortedData} isLoading={isLoading} error={error} rowKey="id"
          onRowClick={(row) => { setSelectedItem(row); setPanelOpen(true); }}
          selectedRowKey={panelOpen && selectedItem ? selectedItem.name : undefined}
          sortState={sortState} onSortChange={(s) => setSortState(s as { key: ClusterRolesSortKey; direction: 'asc' | 'desc' })}
          enableRowSelection={true} selectedRows={selectedRows} onRowSelectionChange={setSelectedRows}
        />

        </div>

      {panelOpen && selectedItem && (
        <>
          <div className="fixed inset-0 z-[95] bg-black/20" onClick={() => setPanelOpen(false)} />
          <ClusterRoleDetailPanel clusterRole={selectedItem} onClose={() => setPanelOpen(false)} onOpenYamlEditor={handleOpenYamlEditorFromPanel} onDelete={handleDeleteSingle} />
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
        description={confirmDelete?.keys.length === 1 ? `Are you sure you want to delete "${confirmDelete?.label}"? This action cannot be undone.` : `Are you sure you want to delete ${confirmDelete?.keys.length} items? This action cannot be undone.`}
        confirmLabel="Delete" destructive isLoading={isDeleting} onConfirm={handleConfirmDelete} onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
};
