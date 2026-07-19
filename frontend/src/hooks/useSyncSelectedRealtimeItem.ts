import { useEffect } from 'react';

export const namespacedResourceKey = (item: { namespace: string; name: string }) =>
  `${item.namespace}/${item.name}`;

export const clusterResourceKey = (item: { name: string }) => item.name;

/** Keep the open detail panel in sync when the realtime list updates the selected row. */
export function useSyncSelectedRealtimeItem<T>(
  items: T[] | undefined,
  selectedKey: string | null,
  selectedItem: T | null,
  setSelectedItem: (item: T | null) => void,
  matchKey: (item: T) => string,
  panelOpen: boolean,
) {
  useEffect(() => {
    if (!panelOpen || !selectedKey || !selectedItem || !items?.length) return;

    const updated = items.find((item) => matchKey(item) === selectedKey);
    if (!updated) {
      setSelectedItem(null);
      return;
    }

    if (JSON.stringify(updated) !== JSON.stringify(selectedItem)) {
      setSelectedItem(updated);
    }
  }, [items, selectedKey, selectedItem, setSelectedItem, matchKey, panelOpen]);
}
