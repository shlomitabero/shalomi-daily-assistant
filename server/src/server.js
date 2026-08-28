import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedIfEmpty } from './db/seed.js';
import { playersRouter } from './routes/players.js';
import { businessRouter } from './routes/business.js';
import { dealsRouter } from './routes/deals.js';
import { worldRouter } from './routes/world.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;

seedIfEmpty();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'FROM ZERO' }));

app.use('/api', playersRouter);
app.use('/api', businessRouter);
app.use('/api', dealsRouter);
app.use('/api', worldRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const clientDist = join(__dirname, '..', '..', 'client', 'dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(join(clientDist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`FROM ZERO server listening on http://localhost:${PORT}`);
});
