import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import http from 'http';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://yawzetkinbbhvaptipdu.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlhd3pldGtpbmJiaHZhcHRpcGR1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTMzNjgyNSwiZXhwIjoyMTA0OTEyODI1fQ.zwKx641VcsWuj3Ei138WjCSiYNStFjtUFpmMxN8Jn-I'
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

async function generateCase(signal, pilotName) {
  try {
    // Get organization
    const { data: org } = await supabase
      .from('organizations')
      .select('id')
      .eq('pilot_name', pilotName)
      .single();

    if (!org) {
      console.error(`Organization ${pilotName} not found`);
      return null;
    }

    // Invoke Claude
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: `Analiza brevemente: ${signal}` }],
    });

    const claudeAnalysis = response.content[0].type === 'text' ? response.content[0].text : '';

    // Create case
    const { data: newCase, error: caseError } = await supabase
      .from('cases')
      .insert({
        organization_id: org.id,
        case_name: `ATLAS Discovery - ${pilotName}`,
        discovery_signal: signal,
        atlas_confidence: 0.92,
        status: 'OPEN',
      })
      .select('id')
      .single();

    if (caseError) {
      console.error('Case error:', caseError);
      return null;
    }

    // Create review item
    await supabase
      .from('review_items')
      .insert({
        case_id: newCase.id,
        recommendation_text: `ATLAS Analysis: ${claudeAnalysis.substring(0, 200)}...`,
        agent_reasoning: { confidence: 0.92, source: 'atlas-engine', pilot: pilotName },
      });

    console.log(`✓ Case created for ${pilotName}: ${newCase.id}`);
    return newCase.id;
  } catch (error) {
    console.error('Error generating case:', error.message);
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'OK' }));
    return;
  }

  if (req.url === '/generate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { signal, pilot } = JSON.parse(body);
        const caseId = await generateCase(signal, pilot || 'Nayra');
        res.writeHead(200);
        res.end(JSON.stringify({ success: !!caseId, caseId }));
      } catch (error) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 ATLAS engine running on port ${PORT}`);
  console.log(`📍 Supabase: ${process.env.SUPABASE_URL}`);
});
