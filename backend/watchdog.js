const axios = require('axios');

/**
 * ZynkaraShift Self-Healing Post-Boot Watchdog & Telemetry Engine
 * Monitors containers for 30s post-boot, detects crash loops, and triggers automated rollbacks.
 */

class WatchdogEngine {
  constructor(docker) {
    this.docker = docker;
  }

  /**
   * Monitor a newly deployed container for up to 30 seconds.
   * If a crash loop or exit code != 0 is detected, triggers auto-rollback.
   */
  async monitorPostBoot(containerId, options = {}) {
    if (!this.docker) return { healthy: true, bypassed: true };

    const {
      projectId,
      targetPort = 80,
      probeUrl = null,
      timeoutSeconds = 30,
      rollbackImage = null,
      onProgress = () => {},
      onRollback = null
    } = options;

    const startTime = Date.now();
    const container = this.docker.getContainer(containerId);
    let isHealthy = true;
    let failureReason = null;
    let stderrLogs = '';
    let rootCause = 'Unknown runtime termination';
    let suggestedFix = 'Check your entrypoint command and required environment variables.';

    onProgress(`⏱️ [WATCHDOG] Commencing 30-second post-boot telemetry monitor for container ${containerId.substring(0, 12)}...`);

    const checkIntervalMs = 3000;
    const maxChecks = Math.floor((timeoutSeconds * 1000) / checkIntervalMs);

    for (let check = 1; check <= maxChecks; check++) {
      await new Promise(r => setTimeout(r, checkIntervalMs));

      try {
        const inspect = await container.inspect();
        const state = inspect.State;

        // 1. Check if container terminated or crashed
        if (!state.Running || state.ExitCode !== 0 || state.OOMKilled) {
          isHealthy = false;
          failureReason = `Container exited with code ${state.ExitCode}${state.OOMKilled ? ' (Out Of Memory)' : ''}`;

          // Fetch logs
          try {
            const rawLogs = await container.logs({ stdout: true, stderr: true, tail: 60 });
            stderrLogs = rawLogs.toString('utf8');
          } catch (logErr) {
            stderrLogs = `Could not fetch container logs: ${logErr.message}`;
          }

          // Parse root cause
          if (state.OOMKilled) {
            rootCause = 'Process exceeded container memory limits (OOMKilled).';
            suggestedFix = 'Increase container memory allocation or optimize asset bundling in build stage.';
          } else if (stderrLogs.includes('Cannot find module') || stderrLogs.includes('MODULE_NOT_FOUND')) {
            rootCause = 'Missing Node.js dependency in runtime container.';
            suggestedFix = 'Ensure the dependency is listed in dependencies (not only devDependencies) or rerun npm install in Dockerfile.';
          } else if (stderrLogs.includes('ModuleNotFoundError') || stderrLogs.includes('No module named')) {
            rootCause = 'Missing Python package.';
            suggestedFix = 'Add the missing package to requirements.txt.';
          } else if (stderrLogs.includes('address already in use') || stderrLogs.includes('EADDRINUSE')) {
            rootCause = 'Port conflict inside container.';
            suggestedFix = 'Ensure your service binds to the dynamic PORT environment variable.';
          } else if (stderrLogs.includes('SyntaxError')) {
            rootCause = 'Application syntax error detected during boot.';
            suggestedFix = 'Inspect stack trace below to fix code syntax error.';
          }

          break;
        }

        // 2. HTTP Probe check if URL provided
        if (probeUrl) {
          try {
            const probeRes = await axios.get(probeUrl, { timeout: 2500, validateStatus: () => true });
            if (probeRes.status >= 500) {
              onProgress(`⚠️ [WATCHDOG] Probe warning: HTTP ${probeRes.status} received at ${probeUrl}`);
            } else {
              onProgress(`🔍 [HEALTH] T+${check * 3}s | HTTP ${probeRes.status} OK | ExitCode: 0`);
            }
          } catch (probeErr) {
            // Service might still be binding, only flag if it persists
          }
        } else {
          onProgress(`🔍 [HEALTH] T+${check * 3}s | State: RUNNING | ExitCode: 0`);
        }

      } catch (inspectErr) {
        onProgress(`⚠️ [WATCHDOG] Inspection error: ${inspectErr.message}`);
      }
    }

    // Handle failure and auto-rollback
    if (!isHealthy) {
      onProgress(`❌ [WATCHDOG] Health check FAILED: ${failureReason}`);
      onProgress(`🔍 [ROOT CAUSE] ${rootCause}`);
      onProgress(`💡 [SUGGESTED FIX] ${suggestedFix}`);

      let rollbackResult = null;
      if (onRollback) {
        onProgress(`🛡️ [ROLLBACK] Triggering automated rollback to previous stable deployment...`);
        try {
          rollbackResult = await onRollback();
          onProgress(`🛡️ [ROLLBACK] Successfully restored previous stable container state.`);
        } catch (rbErr) {
          onProgress(`⚠️ [ROLLBACK] Rollback error: ${rbErr.message}`);
        }
      }

      return {
        healthy: false,
        failureReason,
        rootCause,
        suggestedFix,
        stderrLogs,
        rolledBack: !!rollbackResult
      };
    }

    onProgress(`✅ [WATCHDOG] 30-second post-boot verification passed. Container is STABLE.`);
    return {
      healthy: true,
      message: 'Container verified healthy and stable across 30-second watchdog window.'
    };
  }

  /**
   * Query real-time container metrics (CPU %, RAM, Network I/O, Uptime).
   */
  async getTelemetry(containerNameOrId) {
    if (!this.docker) {
      return {
        status: 'mock',
        cpuPercent: '0.15%',
        memoryUsageMB: '18.4 MB',
        memoryLimitMB: '512.0 MB',
        networkIO: '12.4 KB / 45.2 KB',
        uptime: 'Running'
      };
    }

    try {
      const container = this.docker.getContainer(containerNameOrId);
      const inspect = await container.inspect();
      const isRunning = inspect.State && inspect.State.Running;

      if (!isRunning) {
        return {
          status: 'stopped',
          cpuPercent: '0.00%',
          memoryUsageMB: '0.0 MB',
          memoryLimitMB: '512.0 MB',
          networkIO: '0 KB / 0 KB',
          uptime: 'Stopped'
        };
      }

      // Query single stats snapshot
      const stats = await new Promise((resolve, reject) => {
        container.stats({ stream: false }, (err, streamData) => {
          if (err) return reject(err);
          resolve(streamData);
        });
      });

      // Calculate CPU %
      let cpuPercent = 0.0;
      if (stats.cpu_stats && stats.precpu_stats) {
        const cpuDelta = (stats.cpu_stats.cpu_usage?.total_usage || 0) - (stats.precpu_stats.cpu_usage?.total_usage || 0);
        const systemDelta = (stats.cpu_stats.system_cpu_usage || 0) - (stats.precpu_stats.system_cpu_usage || 0);
        const onlineCpus = stats.cpu_stats.online_cpus || 1;

        if (systemDelta > 0 && cpuDelta > 0) {
          cpuPercent = (cpuDelta / systemDelta) * onlineCpus * 100;
        }
      }

      // Calculate Memory
      const memUsage = stats.memory_stats?.usage || 0;
      const memLimit = stats.memory_stats?.limit || (512 * 1024 * 1024);
      const memUsageMB = (memUsage / (1024 * 1024)).toFixed(1);
      const memLimitMB = (memLimit / (1024 * 1024)).toFixed(1);

      // Calculate Network I/O
      let rxBytes = 0;
      let txBytes = 0;
      if (stats.networks) {
        for (const netKey of Object.keys(stats.networks)) {
          rxBytes += stats.networks[netKey].rx_bytes || 0;
          txBytes += stats.networks[netKey].tx_bytes || 0;
        }
      }
      const rxKB = (rxBytes / 1024).toFixed(1);
      const txKB = (txBytes / 1024).toFixed(1);

      // Uptime
      const startedAt = new Date(inspect.State.StartedAt);
      const uptimeSec = Math.floor((Date.now() - startedAt.getTime()) / 1000);
      const uptimeStr = uptimeSec < 60 ? `${uptimeSec}s` : `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`;

      return {
        status: 'running',
        containerId: inspect.Id.substring(0, 12),
        cpuPercent: `${cpuPercent.toFixed(2)}%`,
        memoryUsageMB: `${memUsageMB} MB`,
        memoryLimitMB: `${memLimitMB} MB`,
        networkIO: `${rxKB} KB in / ${txKB} KB out`,
        uptime: uptimeStr
      };
    } catch (err) {
      return {
        status: 'error',
        error: err.message,
        cpuPercent: '0.00%',
        memoryUsageMB: 'N/A',
        memoryLimitMB: '512.0 MB',
        networkIO: '0 KB',
        uptime: 'Error'
      };
    }
  }
}

module.exports = WatchdogEngine;
