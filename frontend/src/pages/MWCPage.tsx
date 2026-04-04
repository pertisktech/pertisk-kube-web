import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from '../components/Icons';
import { useRealtimeMwcs } from '../hooks/useRealtimeResources';
import { deleteMwc } from '../hooks/useKubernetes';
import { getAuthToken } from '../utils/auth';
import { openPanelTab } from '../components/BottomPanel';
import { DataTable, MwcDetailPanel, ConfirmDialog } from '../components';
import type { Mwc } from '../types';
import { timeAgo } from '../utils';

type MwcSortKey = 'name' | 'webhooks_count' | 'age';

export const MWCPage = () => {
  const { data, isLoading, error } = useRealtimeMwcs();
  const [selectedMwc, setSelectedMwc] = useState<Mwc | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: MwcSortKey; direction: 'asc' | 'desc' }>({
    key: 'age',
    direction: 'desc',
  });

  useEffect(() => {
    if (!data || data.length === 0) {
      setSelectedMwc(null);
      return;
    }
    if (!selectedMwc) {
      setSelectedMwc(data[0]);
      return;
    }
    const updated = data.find((item) => item.name === selectedMwc.name);
    setSelectedMwc(updated ?? data[0]);
  }, [data]);

  const handleOpenYamlEditor = async (mwc: Mwc) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/mwcs/${encodeURIComponent(mwc.name)}/yaml`, {
        headers: token ? { Authorization: token } : {},
      });
      if (!res.ok) throw new Error(res.statusText);
      const yaml = await res.text();
      openPanelTab({ type: 'yaml-editor', yamlContent: yaml, title: mwc.name });
    } catch {
      openPanelTab({ type: 'yaml-editor' });
    }
  };

  const handleDeleteSingle = async (name: string) => {
    setConfirmDelete({ keys: [name], label: name });
    setPanelOpen(false);
  };

  const handleDeleteSelected = () => {
    if (selectedRows.length === 0) return;
    setConfirmDelete({
      keys: selectedRows,
      label: selectedRows.length === 1 ? selectedRows[0] : `${selectedRows.length} Mutating Webhook Configurations`,
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try {
      await Promise.all(confirmDelete.keys.map((name) => deleteMwc(name)));
      setSelectedRows([]);
      setConfirmDelete(null);
    } finally {
      setIsDeleting(false);
    }
  };

  const sortedData = useMemo(() => {
    if (!data) return [];
    const sorted = [...data];
    const factor = sortState.direction === 'asc' ? 1 : -1;
    const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    sorted.sort((a, b) => {
      if (sortState.key === 'name') return compareText(a.name, b.name) * factor;
      if (sortState.key === 'webhooks_count') {
        const r = (a.webhooks_count ?? 0) - (b.webhooks_count ?? 0);
        return (r !== 0 ? r : compareText(a.name, b.name)) * factor;
      }
      if (sortState.key === 'age') {
        const at = Date.parse(a.age || '');
        const bt = Date.parse(b.age || '');
        const r = (Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt);
        return (r !== 0 ? r : compareText(a.name, b.name)) * factor;
      }
      return 0;
    });
    return sorted;
  }, [data, sortState]);

  const columns = [
    {
      header: 'Name',
      accessor: (m: Mwc) => <span className="font-medium text-text break-words">{m.name}</span>,
      width: '50%',
      sortable: true,
      sortKey: 'name' as const,
    },
    {
      header: 'Webhooks',
      accessor: (m: Mwc) => m.webhooks_count ?? 0,
      width: '20%',
      sortable: true,
      sortKey: 'webhooks_count' as const,
    },
    {
      header: 'Age',
      accessor: (m: Mwc) => timeAgo(m.age),
      width: '20%',
      sortable: true,
      sortKey: 'age' as const,
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">
          MWC <span className="text-base font-normal text-text-secondary">(Mutating Webhook Configuration)</span>
        </h1>
      </div>

      <DataTable
        columns={columns}
        data={sortedData}
        rowKey="name"
        isLoading={isLoading}
        error={error}
        sortState={sortState}
        onSortChange={(s) => setSortState(s as { key: MwcSortKey; direction: 'asc' | 'desc' })}
        onRowClick={(row) => {
          setSelectedMwc(row);
          setPanelOpen(true);
        }}
        selectedRowKey={panelOpen && selectedMwc ? selectedMwc.name : undefined}
        enableRowSelection
        selectedRows={selectedRows}
        onRowSelectionChange={setSelectedRows}
      />

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
          <button type="button" onClick={() => setSelectedRows([])} className="text-xs text-text-secondary hover:text-text transition-colors">
            Clear
          </button>
        </div>
      )}

      {panelOpen && selectedMwc && (
        <>
          <div className="fixed inset-0 z-[95] bg-black/20" onClick={() => setPanelOpen(false)} />
          <MwcDetailPanel
            mwc={selectedMwc}
            onClose={() => setPanelOpen(false)}
            onOpenYamlEditor={handleOpenYamlEditor}
            onDelete={handleDeleteSingle}
          />
        </>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.label ?? ''}`}
        description={
          confirmDelete && confirmDelete.keys.length === 1
            ? `Are you sure you want to delete "${confirmDelete.label}"? This action cannot be undone.`
            : `Are you sure you want to delete ${confirmDelete?.keys.length} Mutating Webhook Configurations? This action cannot be undone.`
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
