import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import apiRoutes from './routes/api.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;
const allowedOrigins = new Set(
  (process.env.CORS_ORIGIN || 'http://localhost:5000,http://127.0.0.1:5000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const localDevelopmentOrigin = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
const isDevelopment = process.env.NODE_ENV !== 'production';

app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin) || (isDevelopment && localDevelopmentOrigin.test(origin))) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin not allowed'));
  },
}));
app.use(express.json({ limit: '6mb' }));

// API Routes
app.use('/api', apiRoutes);

app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err.message === 'Origin not allowed') {
    res.status(403).json({ success: false, message: 'Origin not allowed' });
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ success: false, message: 'Malformed JSON request body' });
    return;
  }
  res.status(500).json({ success: false, message: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 SIPGN Helper Backend running on http://localhost:${PORT}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
