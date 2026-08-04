import { Router } from 'express';
import { 
  getDataItems, 
  addDataItem, 
  updateDataItemStatus, 
  deleteDataItem 
} from '../controllers/dataController.js';
import { 
  getTasks, 
  getLogs, 
  runTask 
} from '../controllers/automationController.js';
import { extractReceipt } from '../controllers/receiptController.js';

const router = Router();

// Health Check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'SIPGN Helper Backend API', timestamp: new Date().toISOString() });
});

// Data Routes
router.get('/data', getDataItems);
router.post('/data', addDataItem);
router.patch('/data/:id/status', updateDataItemStatus);
router.delete('/data/:id', deleteDataItem);

// Automation Routes
router.get('/automation/tasks', getTasks);
router.post('/automation/tasks/:taskId/run', runTask);
router.get('/automation/logs', getLogs);

// Receipt OCR (the provider key is kept on the server)
router.post('/receipt/extract', extractReceipt);

export default router;
