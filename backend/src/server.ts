import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import apiRoutes from './routes/api.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

// API Routes
app.use('/api', apiRoutes);

app.listen(PORT, () => {
  console.log(`🚀 SIPGN Helper Backend running on http://localhost:${PORT}`);
});
