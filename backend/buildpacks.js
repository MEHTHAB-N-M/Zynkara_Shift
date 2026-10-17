const fs = require('fs');
const path = require('path');

/**
 * ZynkaraShift Zero-Config Buildpack Engine
 * Auto-detects runtime/framework and synthesizes multi-stage production Dockerfiles.
 */

function detectFramework(repoRoot) {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const requirementsPath = path.join(repoRoot, 'requirements.txt');
  const pyprojectPath = path.join(repoRoot, 'pyproject.toml');
  const pipfilePath = path.join(repoRoot, 'Pipfile');
  const goModPath = path.join(repoRoot, 'go.mod');
  const cargoTomlPath = path.join(repoRoot, 'Cargo.toml');
  const indexHtmlPath = path.join(repoRoot, 'index.html');

  // 1. Node.js Ecosystem
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const scripts = pkg.scripts || {};

      // Next.js
      if (deps['next']) {
        return {
          type: 'node-next',
          name: 'Next.js Application',
          defaultPort: 3000,
          isSpa: false
        };
      }

      // React (Create React App or React 19)
      if (deps['react-scripts'] || (deps['react'] && (scripts['build'] || deps['webpack']))) {
        return {
          type: 'node-react-spa',
          name: 'React SPA',
          defaultPort: 80,
          isSpa: true,
          outputDir: 'build'
        };
      }

      // Vite (React, Vue, Svelte, Vanilla)
      if (deps['vite']) {
        return {
          type: 'node-vite-spa',
          name: 'Vite Frontend Application',
          defaultPort: 80,
          isSpa: true,
          outputDir: 'dist'
        };
      }

      // Vue CLI / Nuxt
      if (deps['nuxt']) {
        return {
          type: 'node-nuxt',
          name: 'Nuxt.js Application',
          defaultPort: 3000,
          isSpa: false
        };
      }

      // General SPA with build script
      if (scripts['build'] && (deps['react'] || deps['vue'] || deps['svelte'] || deps['@angular/core'])) {
        const outDir = fs.existsSync(path.join(repoRoot, 'dist')) ? 'dist' : 'build';
        return {
          type: 'node-generic-spa',
          name: 'Single Page Application (SPA)',
          defaultPort: 80,
          isSpa: true,
          outputDir: outDir
        };
      }

      // Node.js Backend API
      if (deps['express'] || deps['fastify'] || deps['koa'] || deps['@nestjs/core'] || scripts['start'] || pkg.main) {
        return {
          type: 'node-server',
          name: 'Node.js Backend Service',
          defaultPort: 3000,
          isSpa: false,
          startCmd: scripts['start'] ? 'npm start' : `node ${pkg.main || 'server.js'}`
        };
      }

      return {
        type: 'node-generic',
        name: 'Node.js Application',
        defaultPort: 3000,
        isSpa: false,
        startCmd: scripts['start'] ? 'npm start' : 'node index.js'
      };
    } catch (e) {
      console.warn('[BUILDPACK] Could not parse package.json:', e);
    }
  }

  // 2. Python Ecosystem
  if (fs.existsSync(requirementsPath) || fs.existsSync(pyprojectPath) || fs.existsSync(pipfilePath)) {
    let reqs = '';
    if (fs.existsSync(requirementsPath)) {
      reqs = fs.readFileSync(requirementsPath, 'utf8').toLowerCase();
    }

    if (reqs.includes('fastapi') || reqs.includes('uvicorn')) {
      return {
        type: 'python-fastapi',
        name: 'FastAPI / Uvicorn Service',
        defaultPort: 8000,
        isSpa: false
      };
    }

    if (reqs.includes('flask')) {
      return {
        type: 'python-flask',
        name: 'Flask Web Application',
        defaultPort: 5000,
        isSpa: false
      };
    }

    if (reqs.includes('django')) {
      return {
        type: 'python-django',
        name: 'Django Application',
        defaultPort: 8000,
        isSpa: false
      };
    }

    return {
      type: 'python-generic',
      name: 'Python Application',
      defaultPort: 8000,
      isSpa: false
    };
  }

  // 3. Go Ecosystem
  if (fs.existsSync(goModPath)) {
    return {
      type: 'golang',
      name: 'Go Service',
      defaultPort: 8080,
      isSpa: false
    };
  }

  // 4. Rust Ecosystem
  if (fs.existsSync(cargoTomlPath)) {
    return {
      type: 'rust',
      name: 'Rust Application',
      defaultPort: 8080,
      isSpa: false
    };
  }

  // 5. Static HTML site
  if (fs.existsSync(indexHtmlPath)) {
    return {
      type: 'static-html',
      name: 'Static Web Site',
      defaultPort: 80,
      isSpa: true,
      outputDir: '.'
    };
  }

  return null;
}

function synthesizeDockerfile(repoRoot, frameworkInfo) {
  if (!frameworkInfo) {
    frameworkInfo = detectFramework(repoRoot);
  }

  if (!frameworkInfo) {
    return { synthesized: false, reason: 'No recognized framework manifests (package.json, requirements.txt, go.mod, Cargo.toml)' };
  }

  let dockerfileContent = '';

  switch (frameworkInfo.type) {
    case 'node-react-spa':
    case 'node-vite-spa':
    case 'node-generic-spa': {
      const outDir = frameworkInfo.outputDir || 'build';
      dockerfileContent = `# Synthesized by ZynkaraShift Zero-Config Buildpack (${frameworkInfo.name})
# Stage 1: Build Environment
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

COPY . .
RUN npm run build

# Stage 2: Production Web Server
FROM nginx:1.25-alpine AS runner
WORKDIR /usr/share/nginx/html

RUN rm -rf ./*
COPY --from=builder /app/${outDir} ./

# Nginx SPA Fallback configuration
RUN printf 'server {\\n\\
    listen 80;\\n\\
    server_name localhost;\\n\\
    root /usr/share/nginx/html;\\n\\
    index index.html;\\n\\
    location / {\\n\\
        try_files $uri $uri/ /index.html;\\n\\
    }\\n\\
    error_page 500 502 503 504 /50x.html;\\n\\
    location = /50x.html {\\n\\
        root /usr/share/nginx/html;\\n\\
    }\\n\\
}\\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \\
  CMD wget --quiet --tries=1 --spider http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
`;
      break;
    }

    case 'node-next': {
      dockerfileContent = `# Synthesized by ZynkaraShift Zero-Config Buildpack (${frameworkInfo.name})
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
RUN chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \\
  CMD wget --quiet --tries=1 --spider http://localhost:3000/ || exit 1
CMD ["npm", "start"]
`;
      break;
    }

    case 'node-server':
    case 'node-generic': {
      const startCmd = frameworkInfo.startCmd || 'npm start';
      const port = frameworkInfo.defaultPort || 3000;
      dockerfileContent = `# Synthesized by ZynkaraShift Zero-Config Buildpack (${frameworkInfo.name})
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=${port}

COPY package*.json ./
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

COPY . .
RUN chown -R node:node /app
USER node

EXPOSE ${port}
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \\
  CMD wget --quiet --tries=1 --spider http://localhost:${port}/ || exit 1

CMD ${JSON.stringify(startCmd.split(' '))}
`;
      break;
    }

    case 'python-fastapi': {
      dockerfileContent = `# Synthesized by ZynkaraShift Zero-Config Buildpack (${frameworkInfo.name})
FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup -s /bin/bash appuser

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \\
  CMD curl -f http://localhost:8000/ || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
`;
      break;
    }

    case 'python-flask': {
      dockerfileContent = `# Synthesized by ZynkaraShift Zero-Config Buildpack (${frameworkInfo.name})
FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PORT=5000

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup -s /bin/bash appuser

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 5000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \\
  CMD curl -f http://localhost:5000/ || exit 1

CMD ["python", "app.py"]
`;
      break;
    }

    case 'python-generic':
    case 'python-django': {
      dockerfileContent = `# Synthesized by ZynkaraShift Zero-Config Buildpack (${frameworkInfo.name})
FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup -s /bin/bash appuser

COPY requirements.txt* ./
RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi

COPY . .
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 8000
CMD ["python", "main.py"]
`;
      break;
    }

    case 'golang': {
      dockerfileContent = `# Synthesized by ZynkaraShift Zero-Config Buildpack (${frameworkInfo.name})
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/server .

FROM alpine:3.19
WORKDIR /app
RUN addgroup -S appgroup -g 1001 && adduser -S appuser -u 1001 -G appgroup
COPY --from=builder /app/server ./server
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \\
  CMD wget --quiet --tries=1 --spider http://localhost:8080/ || exit 1
CMD ["./server"]
`;
      break;
    }

    case 'rust': {
      dockerfileContent = `# Synthesized by ZynkaraShift Zero-Config Buildpack (${frameworkInfo.name})
FROM rust:1.76-alpine AS builder
WORKDIR /app
RUN apk add --no-cache musl-dev
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

FROM alpine:3.19
WORKDIR /app
RUN addgroup -S appgroup -g 1001 && adduser -S appuser -u 1001 -G appgroup
COPY --from=builder /app/target/release/* ./app_binary
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 8080
CMD ["./app_binary"]
`;
      break;
    }

    case 'static-html':
    default: {
      dockerfileContent = `# Synthesized by ZynkaraShift Zero-Config Buildpack (${frameworkInfo.name})
FROM nginx:1.25-alpine
WORKDIR /usr/share/nginx/html
RUN rm -rf ./*
COPY . .
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \\
  CMD wget --quiet --tries=1 --spider http://localhost:80/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
`;
      break;
    }
  }

  const targetPath = path.join(repoRoot, 'Dockerfile');
  fs.writeFileSync(targetPath, dockerfileContent, 'utf8');

  return {
    synthesized: true,
    framework: frameworkInfo.name,
    type: frameworkInfo.type,
    defaultPort: frameworkInfo.defaultPort,
    dockerfilePath: targetPath
  };
}

module.exports = {
  detectFramework,
  synthesizeDockerfile
};
