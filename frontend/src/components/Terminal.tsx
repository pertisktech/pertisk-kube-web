import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useTheme } from '../context/ThemeContext';
import { getRawAuthToken } from '../utils/auth';

declare global {
  interface Window {
    __PERTISK_CONFIG__?: {
      backendUrl?: string;
    };
  }
}

interface TerminalProps {
  podName: string;
  namespace: string;
  containerName?: string;
  initialCommand?: string;
  onClose?: () => void;
}

const buildExecWebSocketUrl = (namespace: string, podName: string, containerName?: string): string => {
  const runtimeConfig = globalThis as typeof globalThis & {
    __PERTISK_CONFIG__?: { backendUrl?: string };
  };
  const configuredBackendUrl = runtimeConfig.__PERTISK_CONFIG__?.backendUrl?.trim();
  const apiBase = configuredBackendUrl && configuredBackendUrl.length > 0 ? configuredBackendUrl : '/api';
  const token = getRawAuthToken();

  try {
    const backendUrl = new URL(apiBase, globalThis.location.origin);
    backendUrl.protocol = backendUrl.protocol === 'https:' ? 'wss:' : 'ws:';

    const normalizedPath = backendUrl.pathname.replace(/\/+$/, '');
    backendUrl.pathname = normalizedPath.endsWith('/api')
      ? `${normalizedPath}/exec`
      : `${normalizedPath}/api/exec`;

    backendUrl.searchParams.set('namespace', namespace);
    backendUrl.searchParams.set('pod', podName);
    if (containerName) {
      backendUrl.searchParams.set('container', containerName);
    }
    if (token) {
      backendUrl.searchParams.set('token', token);
    }

    return backendUrl.toString();
  } catch {
    const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const fallbackUrl = new URL(`${protocol}//${globalThis.location.host}/api/exec`);
    fallbackUrl.searchParams.set('namespace', namespace);
    fallbackUrl.searchParams.set('pod', podName);
    if (containerName) {
      fallbackUrl.searchParams.set('container', containerName);
    }
    if (token) {
      fallbackUrl.searchParams.set('token', token);
    }
    return fallbackUrl.toString();
  }
};

function buildXtermTheme(isDark: boolean | undefined) {
  const computedStyle = getComputedStyle(document.documentElement);
  const surfaceElevated = computedStyle.getPropertyValue('--color-surface-elevated').trim() || (isDark ? '#15161e' : '#f5f5f5');
  const textColor = computedStyle.getPropertyValue('--color-text').trim() || (isDark ? '#e8e8e9' : '#1a1a1a');
  return {
    background: surfaceElevated,
    foreground: textColor,
    cursor: textColor,
    black: '#000000',
    red: '#cd3131',
    green: isDark ? '#0dbc79' : '#00bc00',
    yellow: isDark ? '#e5e510' : '#949800',
    blue: isDark ? '#2472c8' : '#0451a5',
    magenta: isDark ? '#bc3fbc' : '#bc05bc',
    cyan: isDark ? '#11a8cd' : '#0598bc',
    white: isDark ? '#e5e5e5' : '#555555',
    brightBlack: '#666666',
    brightRed: isDark ? '#f14c4c' : '#cd3131',
    brightGreen: isDark ? '#23d18b' : '#14ce14',
    brightYellow: isDark ? '#f5f543' : '#b5ba00',
    brightBlue: isDark ? '#3b8eea' : '#0451a5',
    brightMagenta: isDark ? '#d670d6' : '#bc05bc',
    brightCyan: isDark ? '#29b8db' : '#0598bc',
    brightWhite: isDark ? '#ffffff' : '#a5a5a5',
  };
}

export const Terminal = ({ podName, namespace, containerName, initialCommand }: TerminalProps) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastSentDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeTimeoutRef = useRef<number | null>(null);
  const theme = useTheme();

  const sendResize = () => {
    const ws = wsRef.current;
    const xterm = xtermRef.current;

    if (!ws || !xterm || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const current = { cols: xterm.cols, rows: xterm.rows };
    const last = lastSentDimensionsRef.current;

    // Only send if dimensions have actually changed
    if (last && last.cols === current.cols && last.rows === current.rows) {
      return;
    }

    lastSentDimensionsRef.current = current;
    ws.send(
      JSON.stringify({
        type: 'resize',
        rows: xterm.rows,
        cols: xterm.cols,
      })
    );
  };

  const handleResize = () => {
    if (resizeTimeoutRef.current) {
      window.clearTimeout(resizeTimeoutRef.current);
    }
    
    resizeTimeoutRef.current = window.setTimeout(() => {
      if (fitAddonRef.current && xtermRef.current) {
        try {
          fitAddonRef.current.fit();
          sendResize();
        } catch (error) {
          console.error('Error during terminal resize:', error);
        }
      }
    }, 50);
  };

  useEffect(() => {
    if (!terminalRef.current) return;

    // Create terminal instance
    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        '"JetBrainsMono Nerd Font", "JetBrains Mono", "Fira Code", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      allowProposedApi: true,
      convertEol: true,
      rows: 30,
      cols: 120,
      scrollback: 1000,
      theme: buildXtermTheme(theme?.isDark),
    });

    // Add addons
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    xterm.loadAddon(fitAddon);
    xterm.loadAddon(webLinksAddon);

    // Open terminal in DOM
    xterm.open(terminalRef.current);
    
    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Fit multiple times to ensure proper sizing before connection
    const performInitialFit = () => {
      requestAnimationFrame(() => {
        fitAddon.fit();
        // Fit again to handle any layout shifts
        requestAnimationFrame(() => {
          fitAddon.fit();
        });
      });
    };
    
    performInitialFit();
    xterm.focus();

    // Connect WebSocket for shell
    const wsUrl = buildExecWebSocketUrl(namespace, podName, containerName);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      xterm.writeln('\x1b[1;32m✓ Connected to pod shell\x1b[0m');
      xterm.writeln(`\x1b[1;36mPod:\x1b[0m ${namespace}/${podName}`);
      if (containerName) {
        xterm.writeln(`\x1b[1;36mContainer:\x1b[0m ${containerName}`);
      }
      xterm.writeln('');
      // Auto-focus terminal after connection
      xterm.focus();
      
      // Ensure terminal is properly sized before sending dimensions
      fitAddon.fit();
      setTimeout(() => {
        fitAddon.fit();
        sendResize();
      }, 50);
      setTimeout(() => {
        fitAddon.fit();
        sendResize();
      }, 150);

      if (namespace === 'node') {
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('\n');
          }
        }, 180);
      }

      if (initialCommand && initialCommand.trim().length > 0) {
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(`${initialCommand.trim()}\n`);
          }
        }, 220);
      }
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        xterm.write(event.data);
      }
    };

    ws.onerror = () => {
      xterm.writeln('\x1b[1;31m✗ WebSocket error\x1b[0m');
    };

    ws.onclose = () => {
      xterm.writeln('\r\n\x1b[1;33m✗ Connection closed\x1b[0m');
    };

    // Send terminal input directly to shell (pass-through mode)
    xterm.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    const handleFocus = () => {
      xterm.focus();
    };

    terminalRef.current.addEventListener('mousedown', handleFocus);

    // Observe container size changes for responsive terminal
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });

    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    // Additional resize attempts to handle initial layout
    const layoutTimers = [
      window.setTimeout(() => {
        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
          sendResize();
        }
      }, 250),
      window.setTimeout(() => {
        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
          sendResize();
        }
      }, 500),
    ];

    window.addEventListener('resize', handleResize);

    return () => {
      if (resizeTimeoutRef.current) {
        window.clearTimeout(resizeTimeoutRef.current);
      }
      terminalRef.current?.removeEventListener('mousedown', handleFocus);
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      layoutTimers.forEach((timer) => window.clearTimeout(timer));
      ws.close();
      xterm.dispose();
    };
  // theme?.isDark is intentionally excluded: theme changes update colors via the
  // separate effect below without reconnecting the WebSocket.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [podName, namespace, containerName, initialCommand]);

  // Update terminal colors live when the theme is toggled, without reconnecting.
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = buildXtermTheme(theme?.isDark);
    }
  }, [theme?.isDark]);

  return (
    <div
      ref={terminalRef}
      className="w-full h-full bg-surface-elevated rounded-md"
      style={{ 
        minHeight: '200px',
        position: 'relative',
        overflow: 'hidden'
      }}
    />
  );
};
