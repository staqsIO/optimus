const { app, BrowserWindow, Tray, Menu, nativeImage, shell, nativeTheme, dialog, systemPreferences } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

/**
 * AutoBot Inbox — Electron shell.
 *
 * Spawns the agent runtime (PGlite + agents + API) and the Next.js dashboard
 * as child processes. The Electron window loads the dashboard URL.
 * Tray icon shows status. Close hides to tray. Quit kills everything.
 *
 * Zero changes to the existing codebase — this is purely a wrapper.
 */

const ROOT = path.resolve(__dirname, '..');
const DASHBOARD_DIR = path.join(ROOT, 'dashboard');

// Load .env so Electron picks up API_PORT, DATABASE_URL, etc.
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const API_PORT = process.env.API_PORT || 3001;
const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 3100;
const IS_DEMO = process.argv.includes('--demo');
const MAX_RESTARTS = 5;

let mainWindow = null;
let tray = null;
let runtimeProcess = null;
let dashboardProcess = null;
let isQuitting = false;
let runtimeRestarts = 0;
let dashboardRestarts = 0;

// ─── App lifecycle ───────────────────────────────────────────────────────────

app.setName('AutoBot Inbox');

app.on('ready', async () => {
  // macOS: set dock icon and build proper application menu so menu bar shows app name
  if (IS_MAC) {
    const iconPath = path.join(__dirname, 'icon.png');
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(iconPath);
    }
    const appMenu = Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Documentation',
            click: () => shell.openExternal('http://localhost:3000/docs'),
          },
        ],
      },
    ]);
    Menu.setApplicationMenu(appMenu);
  }

  createTray();

  // Check ports before launching child processes
  const portsNeeded = [
    { port: API_PORT, name: 'API server' },
    { port: DASHBOARD_PORT, name: 'Dashboard' },
  ];
  for (const { port, name } of portsNeeded) {
    const inUse = await isPortInUse(port);
    if (inUse) {
      dialog.showErrorBox(
        'Port Conflict',
        `${name} port ${port} is already in use.\n\nAnother app is using this port. ` +
        `Either quit that app or set ${name === 'API server' ? 'API_PORT' : 'DASHBOARD_PORT'} ` +
        `in your .env file to a different port.`
      );
      app.quit();
      return;
    }
  }

  // Start runtime first — API must be up before dashboard SSR fetches from it
  startRuntime();
  await waitForServer(`http://localhost:${API_PORT}/api/status`, 30000);
  console.log('[electron] API server ready');

  startDashboard();
  await waitForServer(`http://localhost:${DASHBOARD_PORT}`, 30000);
  console.log('[electron] Dashboard ready');

  createWindow();
});

app.on('activate', () => {
  // macOS: re-show window when dock icon clicked
  if (mainWindow) {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  // macOS: closing window hides to tray (convention)
  // Windows/Linux: closing all windows quits the app
  if (!IS_MAC) {
    cleanup();
    app.quit();
  }
});

// ─── Main window ─────────────────────────────────────────────────────────────

function createWindow() {
  const windowOpts = {
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'AutoBot Inbox',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#09090b' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  };

  // macOS-only: frameless title bar with traffic light controls
  if (IS_MAC) {
    windowOpts.titleBarStyle = 'hiddenInset';
    windowOpts.trafficLightPosition = { x: 16, y: 16 };
  }

  mainWindow = new BrowserWindow(windowOpts);

  mainWindow.loadURL(`http://localhost:${DASHBOARD_PORT}`);

  // Hide instead of close (keeps running in tray)
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── Tray icon ───────────────────────────────────────────────────────────────

function createTray() {
  // 16x16 tray icon — simple circle indicator
  const icon = createTrayIcon('running');
  tray = new Tray(icon);
  tray.setToolTip('AutoBot Inbox — Running');
  updateTrayMenu('running');

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

function updateTrayMenu(status) {
  const statusLabel = status === 'running' ? '● Running' :
                      status === 'halted'  ? '■ Halted' :
                      status === 'starting' ? '○ Starting...' : '? Unknown';

  const menu = Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Open Dashboard',
      click: () => {
        if (mainWindow) mainWindow.show();
        else createWindow();
      },
    },
    { type: 'separator' },
    {
      label: 'Halt Agents',
      click: () => {
        fetch(`http://localhost:${API_PORT}/api/halt`, { method: 'POST' }).catch(() => {});
        updateTrayMenu('halted');
        tray.setToolTip('AutoBot Inbox — Halted');
        tray.setImage(createTrayIcon('halted'));
      },
    },
    {
      label: 'Resume Agents',
      click: () => {
        fetch(`http://localhost:${API_PORT}/api/resume`, { method: 'POST' }).catch(() => {});
        updateTrayMenu('running');
        tray.setToolTip('AutoBot Inbox — Running');
        tray.setImage(createTrayIcon('running'));
      },
    },
    { type: 'separator' },
    {
      label: 'Quit AutoBot Inbox',
      click: () => {
        isQuitting = true;
        cleanup();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

function createTrayIcon(status) {
  // Programmatic 16x16 RGBA tray icon — draw a colored circle
  const size = 16;
  const buf = Buffer.alloc(size * size * 4); // RGBA

  const colors = {
    running:  [34, 197, 94],   // green-500
    halted:   [239, 68, 68],   // red-500
    starting: [245, 158, 11],  // amber-500
  };
  const [r, g, b] = colors[status] || colors.starting;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - 7.5, dy = y - 7.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;

      if (dist <= 6) {
        // Anti-aliased edge
        const alpha = dist > 5 ? Math.max(0, Math.min(255, (6 - dist) * 255)) : 255;
        buf[idx] = r;
        buf[idx + 1] = g;
        buf[idx + 2] = b;
        buf[idx + 3] = Math.round(alpha);
      }
    }
  }

  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

// ─── Agent runtime (child process) ──────────────────────────────────────────

function startRuntime() {
  const args = [path.join(ROOT, 'src', 'index.js')];
  if (IS_DEMO) args.push('--demo');

  // Use spawn with system Node.js instead of fork — Electron's bundled Node
  // has WASM constraints that cause PGlite's Postgres WASM to Abort().
  runtimeProcess = spawn('node', args, {
    cwd: ROOT,
    env: { ...process.env, ELECTRON: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  runtimeProcess.stdout.on('data', (data) => {
    try {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) try { console.log(`[runtime] ${line}`); } catch {}
    } catch {}
  });

  runtimeProcess.stderr.on('data', (data) => {
    try {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) try { console.error(`[runtime] ${line}`); } catch {}
    } catch {}
  });

  runtimeProcess.on('exit', (code) => {
    try { console.log(`[runtime] Exited with code ${code}`); } catch {}
    if (!isQuitting) {
      runtimeRestarts++;
      if (runtimeRestarts > MAX_RESTARTS) {
        try { console.error(`[runtime] Exceeded ${MAX_RESTARTS} restarts — giving up`); } catch {}
        updateTrayMenu('halted');
        tray.setToolTip('AutoBot Inbox — Runtime crashed');
        tray.setImage(createTrayIcon('halted'));
        return;
      }
      try { console.log(`[runtime] Restarting in 3s... (attempt ${runtimeRestarts}/${MAX_RESTARTS})`); } catch {}
      setTimeout(startRuntime, 3000);
    }
  });

  console.log('[electron] Agent runtime started');
}

// ─── Dashboard (child process) ───────────────────────────────────────────────

function startDashboard() {
  // Use next start (production) if .next exists, otherwise next dev
  const hasBuilt = require('fs').existsSync(path.join(DASHBOARD_DIR, '.next'));
  const cmd = hasBuilt ? 'start' : 'dev';

  // On Windows, .bin scripts need shell:true or the .cmd extension
  const nextBin = IS_WIN
    ? path.join(DASHBOARD_DIR, 'node_modules', '.bin', 'next.cmd')
    : path.join(DASHBOARD_DIR, 'node_modules', '.bin', 'next');

  dashboardProcess = spawn(nextBin, [cmd, '-p', String(DASHBOARD_PORT)], {
    cwd: DASHBOARD_DIR,
    env: {
      ...process.env,
      NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`,
      PORT: String(DASHBOARD_PORT),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    // shell:true on Windows ensures .cmd scripts resolve correctly
    shell: IS_WIN,
  });

  dashboardProcess.stdout.on('data', (data) => {
    try { const msg = data.toString().trim(); if (msg) try { console.log(`[dashboard] ${msg}`); } catch {} } catch {}
  });

  dashboardProcess.stderr.on('data', (data) => {
    try { const msg = data.toString().trim(); if (msg && !msg.includes('ExperimentalWarning')) try { console.error(`[dashboard] ${msg}`); } catch {} } catch {}
  });

  dashboardProcess.on('exit', (code) => {
    try { console.log(`[dashboard] Exited with code ${code}`); } catch {}
    if (!isQuitting) {
      dashboardRestarts++;
      if (dashboardRestarts > MAX_RESTARTS) {
        try { console.error(`[dashboard] Exceeded ${MAX_RESTARTS} restarts — giving up`); } catch {}
        updateTrayMenu('halted');
        tray.setToolTip('AutoBot Inbox — Dashboard crashed');
        tray.setImage(createTrayIcon('halted'));
        return;
      }
      try { console.log(`[dashboard] Restarting in 3s... (attempt ${dashboardRestarts}/${MAX_RESTARTS})`); } catch {}
      setTimeout(startDashboard, 3000);
    }
  });

  console.log(`[electron] Dashboard starting (${cmd} mode, port ${DASHBOARD_PORT})`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Check if a port is already in use.
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(true);
      else resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port);
  });
}

/**
 * Wait for a server to accept connections before opening the window.
 * Uses TCP connect (not HTTP GET) to avoid hanging on slow SSR responses.
 */
function waitForServer(url, timeoutMs = 30000) {
  const parsed = new URL(url);
  const port = parseInt(parsed.port || '80', 10);
  const host = parsed.hostname;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const socket = new net.Socket();
      socket.setTimeout(2000);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Server at ${url} did not start within ${timeoutMs}ms`));
        } else {
          setTimeout(check, 500);
        }
      });
      socket.once('timeout', () => {
        socket.destroy();
        setTimeout(check, 500);
      });
      socket.connect(port, host);
    };
    check();
  });
}

function cleanup() {
  // Windows doesn't support SIGTERM — kill() with no signal sends SIGTERM on
  // Unix and terminates the process tree on Windows.
  const signal = IS_WIN ? undefined : 'SIGTERM';
  if (runtimeProcess && !runtimeProcess.killed) {
    runtimeProcess.kill(signal);
  }
  if (dashboardProcess && !dashboardProcess.killed) {
    dashboardProcess.kill(signal);
  }
}

process.on('exit', cleanup);
if (!IS_WIN) {
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
