// === System Routes ===
// /api/status, /api/ide/status, /api/ide/restart, /api/launch-ide, /api/kill-ide
// NOTE: GET /api/ws-url is intentionally NOT here — it lives in server.js (before auth middleware)

const { exec } = require('child_process');
const { hasPm2HubApp, restartManagedIde, launchDesktopIde } = require('../ide-launcher');

// Private helper — get parent PID of a process (cross-platform)
// Only used by /api/kill-ide handler below
function getParentPid(pid) {
    const { execSync } = require('child_process');
    const { platform } = require('../config');
    try {
        if (platform === 'darwin' || platform === 'linux') {
            // ps -o ppid= -p <pid> → returns parent PID
            const ppid = execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf8', timeout: 5000 }).trim();
            return ppid || null;
        } else if (platform === 'win32') {
            // wmic is fast and reliable for getting parent PID
            const out = execSync(`wmic process where ProcessId=${pid} get ParentProcessId /value`, { encoding: 'utf8', timeout: 5000 });
            const match = out.match(/ParentProcessId=(\d+)/);
            return match ? match[1] : null;
        }
    } catch { }
    return null;
}

module.exports = function setupSystemRoutes(app) {
    // Status — hub model (2.0.11): detection = the shared hub LS is up (lsConfig.detected),
    // independent of how many workspaces are tracked (lsInstances). The hub is usable for
    // new chats + history even with 0 tracked workspaces.
    app.get('/api/status', (req, res) => {
        const { lsConfig } = require('../config');
        res.json({ detected: lsConfig.detected, port: lsConfig.port || null });
    });

    // Runtime IDE + Daemon status (for UI daemon status bar)
    app.get('/api/ide/status', async (req, res) => {
        const { platform, lsConfig } = require('../config');
        const { detectIdeInstalled, detectIdeRunning } = require('../profile-manager');
        try {
            const [ideInstalled, ideRunning, pm2Managed] = await Promise.all([
                detectIdeInstalled().catch(() => false),
                detectIdeRunning().catch(() => false),
                hasPm2HubApp().catch(() => false),
            ]);
            res.json({
                lsDetected: Boolean(lsConfig.detected),
                port: lsConfig.port || null,
                ideInstalled,
                ideRunning,
                pm2Managed,
                platform,
            });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Failed to inspect IDE status' });
        }
    });

    // Restart IDE / PM2 antigravity-hub cleanly (e.g. after switching SOCKS5h proxy node)
    app.post('/api/ide/restart', async (req, res) => {
        const { platform } = require('../config');
        try {
            if (await restartManagedIde()) {
                return res.json({ restarted: true, managedBy: 'pm2', platform });
            }
            const launched = launchDesktopIde();
            return res.json({ restarted: launched, managedBy: 'spawn', platform });
        } catch (e) {
            console.error('[!] Restart IDE error:', e.message);
            res.status(500).json({ error: e.message || 'Failed to restart IDE' });
        }
    });

    // Launch IDE — fire-and-forget, opens or restarts the Antigravity IDE application
    // Security: no user input, rate-limited via strictLimiter in server.js, auth-protected
    app.post('/api/launch-ide', async (req, res) => {
        const { platform } = require('../config');
        console.log(`[*] Launch IDE requested (platform: ${platform})`);

        try {
            if (await restartManagedIde()) {
                return res.json({ launched: true, managedBy: 'pm2', platform });
            }
            const launched = launchDesktopIde();
            res.json({ launched, managedBy: 'spawn', platform });
        } catch (e) {
            console.error('[!] Launch IDE error:', e.message);
            res.status(500).json({ error: 'Failed to launch IDE' });
        }
    });

    // Kill IDE — terminate all Antigravity IDE processes (precise PID-based)
    // Strategy: find parent PID of each LS instance (= IDE app) → kill exactly those
    // Security: no user input, rate-limited via strictLimiter in server.js, auth-protected
    app.post('/api/kill-ide', (req, res) => {
        const { exec, execSync } = require('child_process');
        const { platform, lsInstances } = require('../config');
        console.log(`[*] Kill IDE requested (platform: ${platform}, active instances: ${lsInstances.length})`);

        try {
            // Collect unique parent PIDs (IDE processes) from all LS instances
            const parentPids = new Set();
            for (const inst of lsInstances) {
                const ppid = getParentPid(inst.pid);
                if (ppid && ppid !== '0' && ppid !== '1') {
                    parentPids.add(ppid);
                    console.log(`[*] LS PID ${inst.pid} → parent IDE PID ${ppid}`);
                }
            }

            if (parentPids.size > 0) {
                // Kill precisely: only the IDE parent processes
                for (const ppid of parentPids) {
                    try {
                        if (platform === 'win32') {
                            // /T = kill tree (IDE + child LS), /F = force
                            execSync(`taskkill /PID ${ppid} /T /F`, { stdio: 'ignore', timeout: 5000 });
                        } else {
                            // macOS: graceful quit via AppleScript first, then force kill
                            exec('osascript -e \'quit app "Antigravity"\' 2>/dev/null', { timeout: 5000 }, () => {});
                            // Force kill after short delay if still alive
                            setTimeout(() => {
                                try { execSync(`kill -9 ${ppid}`, { stdio: 'ignore', timeout: 3000 }); } catch { }
                                // Also kill any remaining Antigravity processes
                                try { execSync('pkill -9 -i "^Antigravity" 2>/dev/null', { stdio: 'ignore', timeout: 3000 }); } catch { }
                            }, 2000);
                        }
                        console.log(`[*] Killed IDE PID ${ppid}`);
                    } catch (e) {
                        console.log(`[!] Failed to kill PID ${ppid}: ${e.message}`);
                    }
                }
            } else {
                // Fallback: no LS instances detected, use app-level kill
                console.log('[*] No LS instances — using fallback kill');
                if (platform === 'darwin') {
                    // Graceful quit via AppleScript, then force kill if needed
                    exec('osascript -e \'quit app "Antigravity"\' 2>/dev/null', { timeout: 5000 }, () => {});
                    // Also try pkill without -f (match process NAME only, not full cmd line)
                    setTimeout(() => {
                        exec('pkill -i "^Antigravity" 2>/dev/null', { timeout: 5000 }, () => {});
                    }, 2000);
                } else if (platform === 'win32') {
                    const path = require('path');
                    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
                    exec(`"${ps}" -NoProfile -Command "Get-Process | Where-Object { $_.ProcessName -match '^antigravity' } | Stop-Process -Force -ErrorAction SilentlyContinue"`, { timeout: 10000 }, () => {});
                } else {
                    exec('pkill -i "^antigravity" 2>/dev/null', { timeout: 10000 }, () => {});
                }
            }

            // Clear all LS instances since we killed the processes
            const killedCount = lsInstances.length;
            lsInstances.length = 0;

            console.log(`[*] Kill IDE: cleared ${killedCount} LS instances`);
            res.json({ killed: true, platform, instancesCleared: killedCount, preciseKill: parentPids.size > 0, pidCount: parentPids.size });
        } catch (e) {
            console.error('[!] Kill IDE error:', e.message);
            res.status(500).json({ error: 'Failed to kill IDE' });
        }
    });
};
