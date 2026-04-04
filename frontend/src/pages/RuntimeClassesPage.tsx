import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from '../components/Icons';
import { useRealtimeRuntimeClasses } from '../hooks/useRealtimeResources';
import { deleteRuntimeClass } from '../hooks/useKubernetes';
import { DataTable } from '../components/DataTable';
import { RuntimeClassDetailPanel, ConfirmDialog } from '../components';
import type { RuntimeClass } from '../types';
import { timeAgo } from '../utils';

type RuntimeClassSortKey = 'name' | 'handler' | 'scheduling' | 'age';

export const RuntimeClassesPage = () => {
  const { data, isLoading, error } = useRealtimeRuntimeClasses();
  const [selectedRuntimeClass, setSelectedRuntimeClass] = useState<RuntimeClass | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: RuntimeClassSortKey; direction: 'asc' | 'desc' }>({
    key: 'age',
    direction: 'desc',
  });

  useEffect(() => {
    if (!data || data.length === 0) {
      setSelectedRuntimeClass(null);
      return;
    }

    if (!selectedRuntimeClass) {
      setSelectedRuntimeClass(data[0]);
      return;
    }

    const updatedSelected = data.find((item) => item.name === selectedRuntimeClass.name);
    setSelectedRuntimeClass(updatedSelected ?? data[0]);
  }, [data]);

  const handleDeleteSingle = async (name: string) => {
    setConfirmDelete({ keys: [name], label: name });
    setPanelOpen(false);
  };

  const handleDeleteSelected = () => {
    if (selectedRows.length === 0) return;
    setConfirmDelete({
      keys: selectedRows,
      label:
        selectedRows.length === 1
          ? selectedRows[0]
          : `${selectedRows.length} runtime classes`,
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try {
      await Promise.all(confirmDelete.keys.map((name) => deleteRuntimeClass(name)));
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
    const compareText = (left: unknown, right: unknown) =>
      String(left ?? '').localeCompare(String(right ?? ''), undefined, {
        numeric: true,
        sensitivity: 'base',
      });

    sorted.sort((a, b) => {
      if (sortState.key === 'name') return compareText(a.name, b.name) * factor;
      if (sortState.key === 'handler') {
        const result = compareText(a.handler, b.handler);
        return (result !== 0 ? result : compareText(a.name, b.name)) * factor;
      }
      if (sortState.key === 'scheduling') {
        const result = compareText(a.scheduling, b.scheduling);
        return (result !== 0 ? result : compareText(a.name, b.name)) * factor;
      }
      if (sortState.key === 'age') {
        const aTime = Date.parse(a.age || '');
        const bTime = Date.parse(b.age || '');
        const aValue = Number.isNaN(aTime) ? 0 : aTime;
        const bValue = Number.isNaN(bTime) ? 0 : bTime;
        const result = aValue - bValue;
        return (result !== 0 ? result : compareText(a.name, b.name)) * factor;
      }
      return 0;
    });

    return sorted;
  }, [data, sortState]);

  const columns = [
    {
      header: 'Name',
      accessor: (rc: RuntimeClass) => <span className="font-medium text-text">{rc.name}</span>,
      width: '25%',
      sortable: true,
      sortKey: 'name',
    },
    {
      header: 'Handler',
      accessor: (rc: RuntimeClass) => (
        <span className="text-text-secondary font-mono text-sm">{rc.handler}</span>
      ),
      width: '35%',
      sortable: true,
      sortKey: 'handler',
    },
    {
      header: 'Scheduling',
      accessor: (rc: RuntimeClass) => (
        <span
          className={`inline-block px-3 py-1 rounded-full text-sm ${
            rc.scheduling === 'Configured'
              ? 'bg-green-100 text-green-800'
              : 'bg-gray-100 text-gray-800'
          }`}
        >
          {rc.scheduling || '-'}
        </span>
      ),
      width: '20%',
      sortable: true,
      sortKey: 'scheduling',
    },
    {
      header: 'Age',
      accessor: (rc: RuntimeClass) => timeAgo(rc.age),
      width: '15%',
      sortable: true,
      sortKey: 'age',
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Runtime Classes <span className="text-base font-normal text-text-secondary">(Manage Kubernetes Runtime Classes)</span></h1>
      </div>

      <DataTable
        columns={columns}
        data={sortedData}
        rowKey="name"
        isLoading={isLoading}
        error={error}
        sortState={sortState}
        onSortChange={(newSort) =>
          setSortState(newSort as { key: RuntimeClassSortKey; direction: 'asc' | 'desc' })
        }
        onRowClick={(row) => {
          setSelectedRuntimeClass(row);
          setPanelOpen(true);
        }}
        selectedRowKey={panelOpen && selectedRuntimeClass ? selectedRuntimeClass.name : undefined}
        enableRowSelection={true}
        selectedRows={selectedRows}
        onRowSelectionChange={(rows) => setSelectedRows(rows)}
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
          <button
            type="button"
            onClick={() => setSelectedRows([])}
            className="text-xs text-text-secondary hover:text-text transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {panelOpen && selectedRuntimeClass && (
        <>
          <div className="fixed inset-0 z-[95] bg-black/20" onClick={() => setPanelOpen(false)} />
          <RuntimeClassDetailPanel
            runtimeClass={selectedRuntimeClass}
            onClose={() => setPanelOpen(false)}
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
            : `Are you sure you want to delete ${confirmDelete?.keys.length} runtime classes? This action cannot be undone.`
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
