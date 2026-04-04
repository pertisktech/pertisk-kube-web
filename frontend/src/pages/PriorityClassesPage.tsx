import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from '../components/Icons';
import { useRealtimePriorityClasses } from '../hooks/useRealtimeResources';
import { deletePriorityClass } from '../hooks/useKubernetes';
import { DataTable } from '../components/DataTable';
import { PriorityClassDetailPanel, ConfirmDialog } from '../components';
import type { PriorityClass } from '../types';
import { timeAgo } from '../utils';

type PriorityClassSortKey = 'name' | 'value' | 'global_default' | 'age';

export const PriorityClassesPage = () => {
  const { data, isLoading, error } = useRealtimePriorityClasses();
  const [selectedPriorityClass, setSelectedPriorityClass] = useState<PriorityClass | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: PriorityClassSortKey; direction: 'asc' | 'desc' }>({
    key: 'age',
    direction: 'desc',
  });

  useEffect(() => {
    if (!data || data.length === 0) {
      setSelectedPriorityClass(null);
      return;
    }

    if (!selectedPriorityClass) {
      setSelectedPriorityClass(data[0]);
      return;
    }

    const updatedSelected = data.find((item) => item.name === selectedPriorityClass.name);
    setSelectedPriorityClass(updatedSelected ?? data[0]);
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
          : `${selectedRows.length} priority classes`,
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try {
      await Promise.all(confirmDelete.keys.map((name) => deletePriorityClass(name)));
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
      if (sortState.key === 'value') {
        const result = (a.value || 0) - (b.value || 0);
        return (result !== 0 ? result : compareText(a.name, b.name)) * factor;
      }
      if (sortState.key === 'global_default') {
        const result = Number(Boolean(a.global_default)) - Number(Boolean(b.global_default));
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
      accessor: (pc: PriorityClass) => <span className="font-medium text-text">{pc.name}</span>,
      width: '30%',
      sortable: true,
      sortKey: 'name',
    },
    {
      header: 'Value',
      accessor: 'value' as const,
      width: '20%',
      sortable: true,
      sortKey: 'value',
    },
    {
      header: 'Global Default',
      accessor: (pc: PriorityClass) => (
        <span
          className={`inline-block px-3 py-1 rounded-full text-sm ${
            pc.global_default
              ? 'bg-blue-100 text-blue-800'
              : 'bg-gray-100 text-gray-800'
          }`}
        >
          {pc.global_default ? 'Yes' : 'No'}
        </span>
      ),
      width: '25%',
      sortable: true,
      sortKey: 'global_default',
    },
    {
      header: 'Age',
      accessor: (pc: PriorityClass) => timeAgo(pc.age),
      width: '20%',
      sortable: true,
      sortKey: 'age',
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Priority Classes <span className="text-base font-normal text-text-secondary">(Manage Kubernetes Priority Classes)</span></h1>
      </div>

      <DataTable
        columns={columns}
        data={sortedData}
        rowKey="name"
        isLoading={isLoading}
        error={error}
        sortState={sortState}
        onSortChange={(newSort) =>
          setSortState(newSort as { key: PriorityClassSortKey; direction: 'asc' | 'desc' })
        }
        onRowClick={(row) => {
          setSelectedPriorityClass(row);
          setPanelOpen(true);
        }}
        selectedRowKey={panelOpen && selectedPriorityClass ? selectedPriorityClass.name : undefined}
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

      {panelOpen && selectedPriorityClass && (
        <>
          <div className="fixed inset-0 z-[95] bg-black/20" onClick={() => setPanelOpen(false)} />
          <PriorityClassDetailPanel
            priorityClass={selectedPriorityClass}
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
            : `Are you sure you want to delete ${confirmDelete?.keys.length} priority classes? This action cannot be undone.`
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
