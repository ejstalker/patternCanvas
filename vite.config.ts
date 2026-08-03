// vite.config.js
import { defineConfig, type Plugin } from 'vite';
import { resolve, join, normalize } from 'path';
import { promises as fs } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';

function refPplPlugin(): Plugin {
  const refPplDir = resolve(__dirname, 'refPpl');

  const safePath = (name: string): string | null => {
    const decoded = decodeURIComponent(name);
    if (decoded.includes('..') || decoded.includes('/') || decoded.includes('\\')) return null;
    const full = normalize(join(refPplDir, decoded));
    if (!full.startsWith(refPplDir)) return null;
    return full;
  };

  const contentTypeFor = (name: string): string => {
    if (name.endsWith('.sdf')) return 'application/octet-stream';
    if (name.endsWith('.obj')) return 'text/plain; charset=utf-8';
    if (name.endsWith('.mtl')) return 'text/plain; charset=utf-8';
    return 'application/octet-stream';
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

  const copyRefPplToDist = async (outDir: string) => {
    const dest = join(outDir, 'refPpl');
    await fs.mkdir(dest, { recursive: true });
    let entries: string[] = [];
    try {
      entries = await fs.readdir(refPplDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const src = join(refPplDir, entry);
      const stat = await fs.stat(src);
      if (!stat.isFile()) continue;
      await fs.copyFile(src, join(dest, entry));
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
    closeBundle() {
      return copyRefPplToDist(resolve(__dirname, 'dist'));
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
