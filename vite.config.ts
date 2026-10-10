// vite.config.js
import { defineConfig, type Plugin } from 'vite';
import { resolve, join, normalize, sep } from 'path';
import { promises as fs } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';

function refPplPlugin(): Plugin {
  const refPplDir = resolve(__dirname, 'refPpl');
  /** HDRIs live beside the repo, not in public/: served here and copied on build. */
  const hdriDir = resolve(__dirname, 'hdri');

  const safePath = (name: string): string | null => {
    const decoded = decodeURIComponent(name).replace(/\\/g, '/');
    if (decoded.includes('..') || decoded.startsWith('/')) return null;
    const full = normalize(join(refPplDir, decoded));
    if (full !== refPplDir && !full.startsWith(refPplDir + sep)) return null;
    return full;
  };

  const contentTypeFor = (name: string): string => {
    if (name.endsWith('.sdf')) return 'application/octet-stream';
    if (name.endsWith('.obj')) return 'text/plain; charset=utf-8';
    if (name.endsWith('.mtl')) return 'text/plain; charset=utf-8';
    if (name.endsWith('.target')) return 'text/plain; charset=utf-8';
    if (name.endsWith('.json')) return 'application/json; charset=utf-8';
    if (name.endsWith('.exr')) return 'image/x-exr';
    return 'application/octet-stream';
  };

  /** Names of the HDRI files on disk, so the UI never carries a stale list. */
  const listHdriFiles = async (): Promise<string[]> => {
    try {
      const entries = await fs.readdir(hdriDir);
      return entries.filter((e) => !e.startsWith('.')).sort();
    } catch {
      return [];
    }
  };

  const handleRefPpl = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void
  ): Promise<void> => {
    const url = req.url ?? '';
    const pathOnly = url.split('?')[0];

    if (req.method === 'GET' && pathOnly.startsWith('/refPpl/')) {
      const name = pathOnly.slice('/refPpl/'.length);
      const filePath = safePath(name);
      if (!filePath) {
        res.statusCode = 400;
        res.end('Bad path');
        return;
      }
      try {
        const data = await fs.readFile(filePath);
        res.setHeader('Content-Type', contentTypeFor(name));
        res.end(data);
      } catch {
        res.statusCode = 404;
        res.end('Not found');
      }
      return;
    }

    if (req.method === 'GET' && pathOnly.startsWith('/hdri/')) {
      const name = decodeURIComponent(pathOnly.slice('/hdri/'.length));
      if (name === 'index.json') {
        const files = await listHdriFiles();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ files }));
        return;
      }
      // Only plain file names from the folder itself — no traversal.
      if (name.includes('/') || name.includes('\\') || name.includes('..')) {
        res.statusCode = 400;
        res.end('Bad path');
        return;
      }
      const filePath = join(hdriDir, name);
      try {
        const data = await fs.readFile(filePath);
        res.setHeader('Content-Type', contentTypeFor(name));
        res.end(data);
      } catch {
        res.statusCode = 404;
        res.end('Not found');
      }
      return;
    }

    if (req.method === 'PUT' && pathOnly === '/api/avatar-sdf') {
      const fileName = req.headers['x-sdf-file'];
      if (typeof fileName !== 'string') {
        res.statusCode = 400;
        res.end('Missing X-Sdf-File');
        return;
      }
      const filePath = safePath(fileName);
      if (!filePath || !fileName.endsWith('.sdf')) {
        res.statusCode = 400;
        res.end('Invalid SDF file name');
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          await fs.mkdir(refPplDir, { recursive: true });
          await fs.writeFile(filePath, Buffer.concat(chunks));
          res.statusCode = 200;
          res.end('OK');
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
      return;
    }

    if (req.method === 'PUT' && pathOnly === '/api/avatar-obj') {
      const fileName = req.headers['x-obj-file'];
      if (typeof fileName !== 'string') {
        res.statusCode = 400;
        res.end('Missing X-Obj-File');
        return;
      }
      const filePath = safePath(fileName);
      if (!filePath || !fileName.endsWith('.obj')) {
        res.statusCode = 400;
        res.end('Invalid OBJ file name');
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          await fs.mkdir(refPplDir, { recursive: true });
          await fs.writeFile(filePath, Buffer.concat(chunks), 'utf8');
          res.statusCode = 200;
          res.end('OK');
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
      return;
    }

    next();
  };

  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    void handleRefPpl(req, res, next);
  };

  const copyRefPplDir = async (outDir: string, rel = ''): Promise<void> => {
    const srcDir = join(refPplDir, rel);
    const destDir = join(outDir, 'refPpl', rel);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(srcDir);
    } catch {
      return;
    }
    await fs.mkdir(destDir, { recursive: true });
    for (const entry of entries) {
      const src = join(srcDir, entry);
      const stat = await fs.stat(src);
      if (stat.isDirectory()) {
        await copyRefPplDir(outDir, join(rel, entry));
      } else if (stat.isFile()) {
        await fs.copyFile(src, join(destDir, entry));
      }
    }
  };

  const copyRefPplToDist = (outDir: string) => copyRefPplDir(outDir);

  /** Same deal for the HDRIs, plus the index the app reads. */
  const copyHdriToDist = async (outDir: string): Promise<void> => {
    const destDir = join(outDir, 'hdri');
    try {
      await fs.mkdir(destDir, { recursive: true });
      for (const entry of await fs.readdir(hdriDir)) {
        if (entry.startsWith('.')) continue;
        await fs.copyFile(join(hdriDir, entry), join(destDir, entry));
      }
      const files = await listHdriFiles();
      await fs.writeFile(
        join(destDir, 'index.json'),
        JSON.stringify({ files }),
        'utf8'
      );
    } catch {
      /* no hdri folder: nothing to publish */
    }
  };

  return {
    name: 'refPpl',
    configureServer(server) {
      // Run before Vite static middleware so /refPpl/* is not served as raw assets.
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    async closeBundle() {
      const outDir = resolve(__dirname, 'dist');
      await copyRefPplToDist(outDir);
      await copyHdriToDist(outDir);
    },
  };
}

export default defineConfig({
  plugins: [refPplPlugin()],
  server: {
    allowedHosts: true,
    fs: {
      // refPpl lives outside src; allow reads but route HTTP via our middleware.
      allow: ['..'],
    },
  },
  assetsInclude: ['**/*.wgsl'],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        demo: resolve(__dirname, 'demo.html'),
      },
      output: {
        manualChunks: undefined,
      },
    },
  },
});
