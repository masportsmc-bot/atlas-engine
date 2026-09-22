import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/run', async (req, res) => {
  try {
    console.log('[ATLAS] Ciclo iniciado');
    res.json({ status: 'COMPLETE', message: 'ATLAS E2E ejecutado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'OK' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ATLAS corriendo en puerto ${PORT}`));
