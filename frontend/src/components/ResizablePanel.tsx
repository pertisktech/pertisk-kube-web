import { useState, useRef, useEffect, type ReactNode } from 'react';

interface ResizablePanelProps {
  children: ReactNode;
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: string;
}

export const ResizablePanel = ({
  children,
  minWidth = 280,
  maxWidth = 720,
  defaultWidth = '460px',
}: ResizablePanelProps) => {
  const [width, setWidth] = useState<string>(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing || !panelRef.current) return;

      const windowWidth = window.innerWidth;
      const newWidth = windowWidth - e.clientX;
      
      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setWidth(`${newWidth}px`);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    if (isResizing) {
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, minWidth, maxWidth]);

  const handleMouseDown = () => {
    setIsResizing(true);
  };

  return (
    <aside
      ref={panelRef}
      className="fixed top-0 right-0 z-[100] h-screen shadow-2xl"
      style={{
        width,
        backgroundColor: 'var(--color-surface)',
        borderLeft: '1px solid var(--color-border)',
      }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/30 transition-colors"
        onMouseDown={handleMouseDown}
        role="separator"
        aria-label="Resize panel"
      />
      {children}
    </aside>
  );
};
