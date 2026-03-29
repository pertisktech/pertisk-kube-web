import { ReactNode } from 'react';
import { Loader, ArrowUp, ArrowDown, ArrowUpDown } from './Icons';
import { cn } from '../utils';
import { Checkbox } from './Checkbox';

export type SortDirection = 'asc' | 'desc';

const activeSortColor = 'var(--color-primary)';
const inactiveSortColor = 'var(--color-muted)';

function SortHeaderButton({
  header,
  sortKey,
  sortState,
  onSortChange,
}: {
  header: string;
  sortKey: string;
  sortState?: SortState | null;
  onSortChange: (sort: SortState) => void;
}) {
  const isActive = sortState?.key === sortKey;
  const direction = isActive ? sortState.direction : null;
  const nextDirection: SortDirection =
    isActive && direction === 'asc' ? 'desc' : 'asc';
  const ariaLabel = direction === 'asc' ? `${header}: ascending, click for descending` : direction === 'desc' ? `${header}: descending, click for ascending` : `${header}: sort`;

  return (
    <button
      type="button"
      onClick={() => onSortChange({ key: sortKey, direction: nextDirection })}
      className="inline-flex items-center gap-1 hover:opacity-90"
      style={{ color: 'var(--color-text)' }}
      aria-label={ariaLabel}
      title={direction === 'asc' ? 'Sort descending' : direction === 'desc' ? 'Sort ascending' : 'Sort'}
    >
      <span>{header}</span>
      {direction === 'asc' ? (
        <span style={{ color: activeSortColor }}><ArrowUp size={14} /></span>
      ) : direction === 'desc' ? (
        <span style={{ color: activeSortColor }}><ArrowDown size={14} /></span>
      ) : (
        <span style={{ color: inactiveSortColor }}><ArrowUpDown size={14} /></span>
      )}
    </button>
  );
}

export interface SortState {
  key: string;
  direction: SortDirection;
}

interface Column<T> {
  header: string;
  accessor: keyof T | ((row: T) => ReactNode);
  render?: (row: T) => ReactNode;
  width?: string;
  headerClassName?: string;
  cellClassName?: string;
  sortable?: boolean;
  sortKey?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  isLoading: boolean;
  error?: string | null;
  rowKey: keyof T | ((row: T) => string);
  onRowClick?: (row: T) => void;
  selectedRowKey?: string;
  sortState?: SortState;
  onSortChange?: (sort: SortState) => void;
  selectedRows?: string[];
  onRowSelectionChange?: (selectedKeys: string[]) => void;
  enableRowSelection?: boolean;
  autoFitContent?: boolean;
  allowHorizontalScroll?: boolean;
}

export const DataTable = <T extends Record<string, any>>({
  columns,
  data,
  isLoading,
  error,
  rowKey,
  onRowClick,
  selectedRowKey,
  sortState,
  onSortChange,
  selectedRows = [],
  onRowSelectionChange,
  enableRowSelection = false,
  autoFitContent = true,
  allowHorizontalScroll = true,
}: DataTableProps<T>) => {
  const getRowKeyValue = (row: T) =>
    typeof rowKey === 'function' ? rowKey(row) : String(row[rowKey]);

  if (error) {
    return (
      <div className="status-red border rounded-lg p-4">
        Error loading data: {error}
      </div>
    );
  }

  const handleSelectAll = (checked: boolean) => {
    if (onRowSelectionChange) {
      if (checked) {
        const allKeys = data.map((row) => getRowKeyValue(row));
        onRowSelectionChange(allKeys);
      } else {
        onRowSelectionChange([]);
      }
    }
  };

  const handleRowSelect = (rowKeyValue: string, checked: boolean) => {
    if (onRowSelectionChange) {
      if (checked) {
        onRowSelectionChange([...selectedRows, rowKeyValue]);
      } else {
        onRowSelectionChange(selectedRows.filter((key) => key !== rowKeyValue));
      }
    }
  };

  const allSelected = enableRowSelection && data.length > 0 && selectedRows.length === data.length;
  const someSelected = enableRowSelection && selectedRows.length > 0 && selectedRows.length < data.length;

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden text-sm">
      <div className="px-3 py-2 border-b border-border bg-surface-elevated text-sm text-text-secondary">
        Total: {data.length} records
      </div>
      <div className={allowHorizontalScroll ? 'overflow-x-auto' : 'overflow-x-hidden'}>
        <table className={cn('text-sm', autoFitContent ? 'table-auto w-max min-w-full' : 'table-fixed w-full')}>
          <thead>
            <tr className="border-b border-border bg-surface-elevated">
              {columns.map((col, idx) => (
                <th
                  key={idx}
                  className={cn(
                    'px-3 py-2 text-left text-sm font-semibold text-text align-middle',
                    col.headerClassName
                  )}
                  style={{ width: col.width, minWidth: col.width, maxWidth: col.width, whiteSpace: autoFitContent ? 'nowrap' : undefined }}
                >
                  {enableRowSelection && idx === 0 ? (
                    <div className="flex items-center gap-2">
                      <span onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={allSelected}
                          indeterminate={someSelected}
                          onChange={(e) => handleSelectAll(e.target.checked)}
                        />
                      </span>
                      {col.sortable && col.sortKey && onSortChange ? (
                        <SortHeaderButton
                          header={col.header}
                          sortKey={col.sortKey}
                          sortState={sortState}
                          onSortChange={onSortChange}
                        />
                      ) : (
                        col.header
                      )}
                    </div>
                  ) : col.sortable && col.sortKey && onSortChange ? (
                    <SortHeaderButton
                      header={col.header}
                      sortKey={col.sortKey}
                      sortState={sortState}
                      onSortChange={onSortChange}
                    />
                  ) : (
                    col.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-12 text-center text-sm">
                  <div className="flex flex-col items-center gap-2">
                    <Loader size={32} className="text-primary animate-spin" />
                    <p className="text-text-secondary">Loading...</p>
                  </div>
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-sm text-text-secondary">
                  No data available
                </td>
              </tr>
            ) : (
            data.map((row, rowIdx) => {
              const rowKeyValue = getRowKeyValue(row);
              const isSelected = selectedRows.includes(rowKeyValue);

              return (
                <tr
                  key={rowKeyValue}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    'border-b border-border',
                    rowIdx % 2 === 0 ? 'bg-surface' : 'bg-surface-elevated',
                    onRowClick && 'cursor-pointer hover:bg-hover',
                    selectedRowKey === rowKeyValue && 'bg-hover',
                    isSelected && 'bg-hover'
                  )}
                >
                  {columns.map((col, colIdx) => (
                    <td
                      key={colIdx}
                      className={cn(
                        'px-3 py-2 align-middle text-sm',
                        autoFitContent && 'whitespace-nowrap',
                        col.cellClassName,
                        col.header === 'Name' && typeof col.accessor !== 'function'
                          ? 'text-text font-medium'
                          : 'text-text-secondary'
                      )}
                      style={col.width ? { width: col.width, minWidth: col.width, maxWidth: col.width } : undefined}
                    >
                      {(() => {
                        const cellValue =
                          typeof col.render === 'function'
                            ? col.render(row)
                            : typeof col.accessor === 'function'
                              ? col.accessor(row)
                              : row[col.accessor] != null
                                ? String(row[col.accessor])
                                : '-';

                        const content = col.header === 'Age'
                          ? <span className="whitespace-nowrap">{cellValue}</span>
                          : cellValue;

                        if (enableRowSelection && colIdx === 0) {
                          return (
                            <div className="flex items-center gap-2">
                              <span onClick={(e) => e.stopPropagation()}>
                                <Checkbox
                                  checked={isSelected}
                                  onChange={(e) => handleRowSelect(rowKeyValue, e.target.checked)}
                                />
                              </span>
                              {content}
                            </div>
                          );
                        }

                        return content;
                      })()}
                    </td>
                  ))}
                </tr>
              );
            })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
