import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createStateHandler } from './api/state.js';
import { createCostHandler } from './api/cost.js';
import { createTaskVerifyHandler } from './api/task-verify.js';
import { createArchivesListHandler, createArchiveDetailHandler } from './api/archives.js';
import { createSiderailHandler } from './api/siderail.js';
import config from '../orchestrator/infra/config.js';
import { startNotifyWatcher } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer({ projectRoot = process.cwd(), archivesDir = path.join(process.cwd(), 'archives') } = {}) {
  const app = express();

  app.get('/api/archives', createArchivesListHandler({ archivesDir }));
  app.get('/api/archive/:id', createArchiveDetailHandler({ archivesDir }));
  app.get('/api/state', createStateHandler({ projectRoot }));
  app.get('/api/siderail', createSiderailHandler({ projectRoot, archivesDir }));
  app.get('/api/cost', createCostHandler({ projectRoot }));
  app.get('/api/task/:id/verify', createTaskVerifyHandler({ projectRoot }));

  // Serve archived run artifacts (report.html and friends) so links like
  // /archives/<id>/report.html from the archive-detail page resolve.
  app.use('/archives', express.static(archivesDir));

  app.use('/', express.static(path.join(__dirname, 'public')));

  return {
    app,
    listen(port) {
      const httpServer = app.listen(port);

      if (typeof config.ui?.notifyWebhookUrl === 'string' && config.ui.notifyWebhookUrl.length > 0) {
        const getSnapshot = async () => {
          const { port: boundPort } = httpServer.address();
          const res = await fetch(`http://127.0.0.1:${boundPort}/api/siderail`);
          return res.json();
        };

        startNotifyWatcher({
          getSnapshot,
          webhookUrl: config.ui.notifyWebhookUrl,
          intervalMs: config.ui.siderailPollMs,
          log: console.warn,
        });
      }

      return httpServer;
    },
  };
}
