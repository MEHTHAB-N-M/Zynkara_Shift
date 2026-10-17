const fs = require('fs');
const Docker = require('dockerode');
const WatchdogEngine = require('./watchdog');

class OrchestrationService {
  constructor() {
    this.volumesBasePath = process.env.VOLUMES_BASE_PATH || '/var/zynkara/volumes';
    this.traefikNetwork = process.env.TRAEFIK_NETWORK || 'zynkara-traefik-net';
    this.platformDomain = process.env.PLATFORM_DOMAIN || 'zynkarashift.duckdns.org';
    
    try {
      this.docker = new Docker();
      this.watchdog = new WatchdogEngine(this.docker);
    } catch (e) {
      console.error("Warning: Failed to connect to docker daemon:", e);
      this.docker = null;
      this.watchdog = new WatchdogEngine(null);
    }
  }

  _generatePassword(length = 16) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let pass = '';
    for (let i = 0; i < length; i++) {
      const idx = Math.floor(Math.random() * chars.length);
      pass += chars[idx];
    }
    return pass;
  }

  async _getOrCreateNetwork(networkName) {
    if (!this.docker) throw new Error("Docker client not initialized");
    const network = this.docker.getNetwork(networkName);
    try {
      await network.inspect();
      return network;
    } catch (err) {
      if (err.statusCode === 404) {
        console.log(`Creating isolated bridge network: ${networkName}`);
        return await this.docker.createNetwork({
          Name: networkName,
          Driver: 'bridge',
          Options: {
            "com.docker.network.bridge.enable_icc": "true"
          }
        });
      }
      throw err;
    }
  }

  async stopAndRemoveProjectContainers(projectId) {
    if (!this.docker) return;
    
    const appName = `zynkara-app-${projectId}`;
    const dbName = `zynkara-db-${projectId}`;
    const netName = `zynkara-project-${projectId}`;

    // Stop and remove app
    try {
      const app = this.docker.getContainer(appName);
      console.log(`Stopping and removing app container: ${appName}`);
      await app.stop({ t: 5 });
      await app.remove();
    } catch (e) {
      // Ignored if not exists
    }

    // Stop and remove db
    try {
      const db = this.docker.getContainer(dbName);
      console.log(`Stopping and removing db container: ${dbName}`);
      await db.stop({ t: 5 });
      await db.remove();
    } catch (e) {
      // Ignored if not exists
    }

    // Remove isolated network
    try {
      const net = this.docker.getNetwork(netName);
      console.log(`Removing isolated project network: ${netName}`);
      await net.remove();
    } catch (e) {
      // Ignored if not exists
    }
  }

  async pullImage(imageName) {
    if (!this.docker) throw new Error("Docker client not initialized");
    console.log(`Pulling image: ${imageName}`);
    return new Promise((resolve, reject) => {
      this.docker.pull(imageName, (err, stream) => {
        if (err) return reject(err);
        this.docker.modem.followProgress(stream, onFinished, onProgress);
        function onFinished(err, output) {
          if (err) return reject(err);
          resolve(output);
        }
        function onProgress(event) {
          // Progress updates logging (optional)
        }
      });
    });
  }

  async provisionDatabase(ownerId, projectId, dbType) {
    if (!this.docker) throw new Error("Docker client not initialized");

    const dbName = `zynkara-db-${projectId}`;
    const netName = `zynkara-project-${projectId}`;

    // Clean up existing db container
    try {
      const oldDb = this.docker.getContainer(dbName);
      await oldDb.stop({ t: 2 });
      await oldDb.remove();
    } catch (e) {}

    // Credentials setup
    const dbUser = 'zynkara_user';
    const dbPass = this._generatePassword();
    const dbDatabase = `zynkara_db_${projectId.replace(/-/g, '_')}`;

    let dbEnv = [];
    let connectionInfo = {};
    let imageName = '';
    let containerDbPath = '';
    let dbPort = '';
    let cmd = null;

    if (dbType === 'postgres') {
      imageName = 'postgres:15-alpine';
      containerDbPath = '/var/lib/postgresql/data';
      dbPort = '5432';
      dbEnv = [
        `POSTGRES_USER=${dbUser}`,
        `POSTGRES_PASSWORD=${dbPass}`,
        `POSTGRES_DB=${dbDatabase}`
      ];
      connectionInfo = {
        DB_TYPE: dbType,
        DB_HOST: dbName,
        DB_PORT: dbPort,
        DB_USER: dbUser,
        DB_PASSWORD: dbPass,
        DB_NAME: dbDatabase,
        DATABASE_URL: `postgresql://${dbUser}:${dbPass}@${dbName}:${dbPort}/${dbDatabase}`
      };
    } else if (dbType === 'mysql') {
      imageName = 'mysql:8.0';
      containerDbPath = '/var/lib/mysql';
      dbPort = '3306';
      dbEnv = [
        `MYSQL_USER=${dbUser}`,
        `MYSQL_PASSWORD=${dbPass}`,
        `MYSQL_DATABASE=${dbDatabase}`,
        'MYSQL_RANDOM_ROOT_PASSWORD=yes'
      ];
      connectionInfo = {
        DB_TYPE: dbType,
        DB_HOST: dbName,
        DB_PORT: dbPort,
        DB_USER: dbUser,
        DB_PASSWORD: dbPass,
        DB_NAME: dbDatabase,
        DATABASE_URL: `mysql+pymysql://${dbUser}:${dbPass}@${dbName}:${dbPort}/${dbDatabase}`
      };
    } else if (dbType === 'mongodb') {
      imageName = 'mongo:6.0';
      containerDbPath = '/data/db';
      dbPort = '27017';
      dbEnv = [
        `MONGO_INITDB_ROOT_USERNAME=${dbUser}`,
        `MONGO_INITDB_ROOT_PASSWORD=${dbPass}`,
        `MONGO_INITDB_DATABASE=${dbDatabase}`
      ];
      connectionInfo = {
        DB_TYPE: dbType,
        DB_HOST: dbName,
        DB_PORT: dbPort,
        DB_USER: dbUser,
        DB_PASSWORD: dbPass,
        DB_NAME: dbDatabase,
        DATABASE_URL: `mongodb://${dbUser}:${dbPass}@${dbName}:${dbPort}/${dbDatabase}?authSource=admin`
      };
    } else if (dbType === 'redis') {
      imageName = 'redis:7-alpine';
      containerDbPath = '/data';
      dbPort = '6379';
      dbEnv = [];
      cmd = ['redis-server', '--requirepass', dbPass];
      connectionInfo = {
        DB_TYPE: dbType,
        DB_HOST: dbName,
        DB_PORT: dbPort,
        DB_PASSWORD: dbPass,
        DATABASE_URL: `redis://:${dbPass}@${dbName}:${dbPort}/0`
      };
    } else {
      throw new Error(`Unsupported database type: ${dbType}`);
    }

    // Pull image if not cached
    try {
      await this.pullImage(imageName);
    } catch (err) {
      console.warn(`Could not pull database image ${imageName}, trying to run anyway:`, err);
    }

    // Volumes base path
    const hostVolumePath = `${this.volumesBasePath}/${ownerId}/${projectId}/${dbType}`;
    try {
      fs.mkdirSync(hostVolumePath, { recursive: true });
    } catch (e) {
      console.error("Warning: Volume directory could not be created:", e);
    }

    // Ensure per-project isolated network exists
    try {
      await this._getOrCreateNetwork(netName);
    } catch (e) {
      console.warn(`Could not ensure isolated project network ${netName}:`, e);
    }

    console.log(`Deploying database container: ${dbName} (${imageName})`);
    const container = await this.docker.createContainer({
      Image: imageName,
      name: dbName,
      Env: dbEnv,
      Cmd: cmd,
      HostConfig: {
        NetworkMode: netName,
        RestartPolicy: { Name: 'unless-stopped' },
        Binds: [`${hostVolumePath}:${containerDbPath}:rw`],
        Memory: 512 * 1024 * 1024,
        MemorySwap: 1024 * 1024 * 1024, // Enforce 1GB total limit (512MB RAM + 512MB swap)
        NanoCpus: 500000000, // 0.5 CPU core
        CpuPeriod: 100000,
        CpuQuota: 50000,
        SecurityOpt: ['no-new-privileges:true'],
        PidsLimit: 150,
        CapDrop: ['ALL'],
        CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER']
      }
    });

    await container.start();
    return { dbEnv, connectionInfo };
  }

  async deployApp(ownerId, projectId, subdomain, appImage, appPort, envVars = {}, dbConnectionInfo = {}, watchdogOptions = null) {
    if (!this.docker) throw new Error("Docker client not initialized");

    const appName = `zynkara-app-${projectId}`;
    const projectNetName = `zynkara-project-${projectId}`;

    // Inspect previous app container if exists (for auto-rollback preservation)
    let previousImage = null;
    try {
      const oldApp = this.docker.getContainer(appName);
      const oldInspect = await oldApp.inspect();
      if (oldInspect && oldInspect.Config && oldInspect.Config.Image) {
        previousImage = oldInspect.Config.Image;
      }
      await oldApp.stop({ t: 2 });
      await oldApp.remove();
    } catch (e) {}

    // Pull image if not local build
    if (!appImage.startsWith('zynkara-local-')) {
      try {
        await this.pullImage(appImage);
      } catch (err) {
        console.warn(`Failed to pull app image ${appImage}, attempting to run:`, err);
      }
    }

    // Environment variables array
    const combinedEnv = { ...dbConnectionInfo, ...envVars };
    const envArray = Object.entries(combinedEnv).map(([key, val]) => `${key}=${val}`);

    // Traefik labels
    const traefikLabels = {
      "traefik.enable": "true",
      [`traefik.http.routers.zynkara-${projectId}.rule`]: `Host(\`${subdomain}.localhost\`) || Host(\`${subdomain}.${this.platformDomain}\`)`,
      [`traefik.http.routers.zynkara-${projectId}.entrypoints`]: "web,websecure",
      [`traefik.http.services.zynkara-${projectId}.loadbalancer.server.port`]: String(appPort),
      "traefik.docker.network": this.traefikNetwork
    };

    // Ensure per-project isolated network exists
    try {
      await this._getOrCreateNetwork(projectNetName);
    } catch (e) {
      console.warn(`Could not ensure isolated project network ${projectNetName}:`, e);
    }

    console.log(`Deploying application container: ${appName} (${appImage})`);
    const appContainer = await this.docker.createContainer({
      Image: appImage,
      name: appName,
      Env: envArray,
      Labels: traefikLabels,
      HostConfig: {
        NetworkMode: projectNetName,
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: 512 * 1024 * 1024,
        MemorySwap: 1024 * 1024 * 1024, // Enforces 1GB total limit (512MB RAM + 512MB swap)
        NanoCpus: 500000000, // 0.5 CPU core
        CpuPeriod: 100000,
        CpuQuota: 50000, // Enforces 50% CPU limit
        SecurityOpt: ['no-new-privileges:true'],
        PidsLimit: 100, // Prevents fork bombs
        CapDrop: ['ALL'],
        CapAdd: ['NET_BIND_SERVICE']
      }
    });

    // Attach container to Traefik network
    try {
      const traefikNet = this.docker.getNetwork(this.traefikNetwork);
      await traefikNet.connect({ Container: appContainer.id });
    } catch (err) {
      console.error(`Failed to attach app container to Traefik network:`, err);
    }

    // Start container
    await appContainer.start();

    // Execute Self-Healing Post-Boot Health Checks if options passed
    if (watchdogOptions) {
      const rollbackCallback = (previousImage && previousImage !== appImage) ? async () => {
        console.log(`[ROLLBACK] Reverting to previous stable image: ${previousImage}`);
        try {
          await appContainer.stop({ t: 2 });
          await appContainer.remove();
        } catch (e) {}
        return await this.deployApp(ownerId, projectId, subdomain, previousImage, appPort, envVars, dbConnectionInfo, null);
      } : null;

      const healthResult = await this.watchdog.monitorPostBoot(appContainer.id, {
        projectId,
        targetPort: appPort,
        probeUrl: watchdogOptions.probeUrl,
        timeoutSeconds: watchdogOptions.timeoutSeconds || 30,
        rollbackImage: previousImage,
        onProgress: watchdogOptions.onProgress || console.log,
        onRollback: rollbackCallback
      });

      if (!healthResult.healthy) {
        const error = new Error(`Post-boot health check failed: ${healthResult.failureReason}`);
        error.healthDetails = healthResult;
        throw error;
      }
    }

    return appContainer;
  }

  async getContainerTelemetry(projectId) {
    const appName = `zynkara-app-${projectId}`;
    return await this.watchdog.getTelemetry(appName);
  }

  async getContainerLogs(projectId, tail = 100) {
    if (!this.docker) return "Docker client not available.";
    try {
      const container = this.docker.getContainer(`zynkara-app-${projectId}`);
      const logsBuffer = await container.logs({
        stdout: true,
        stderr: true,
        tail: tail,
        timestamps: false
      });
      return this._parseDockerLogs(logsBuffer);
    } catch (e) {
      return "Application container not found or starting up...";
    }
  }

  async getContainerStatus(projectId) {
    if (!this.docker) return "unknown";
    try {
      const container = this.docker.getContainer(`zynkara-app-${projectId}`);
      const info = await container.inspect();
      return info.State.Status; // running, exited, paused, etc.
    } catch (e) {
      return "offline";
    }
  }

  _parseDockerLogs(buffer) {
    if (!Buffer.isBuffer(buffer)) return String(buffer);
    
    let offset = 0;
    let output = '';
    while (offset < buffer.length) {
      if (offset + 8 > buffer.length) break;
      // Byte 0 indicates stdout (1) vs stderr (2). Bytes 4-7 indicate message length.
      const length = buffer.readUInt32BE(offset + 4);
      if (offset + 8 + length > buffer.length) {
        output += buffer.toString('utf8', offset + 8);
        break;
      }
      output += buffer.toString('utf8', offset + 8, offset + 8 + length);
      offset += 8 + length;
    }
    return output || buffer.toString('utf8');
  }
}

module.exports = OrchestrationService;
