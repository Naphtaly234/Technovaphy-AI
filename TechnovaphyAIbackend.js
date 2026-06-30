// server.js – Complete backend with Groq + Supabase + Stripe
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
//  ENVIRONMENT VARIABLES (NEVER hardcode API keys!)
// ============================================================
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
//  MESSAGE LIMITS
// ============================================================
const TIER_LIMITS = {
  free: 200,
  starter: 550,
  pro: 2500,
  enterprise: Infinity,
};

const TIER_NAMES = {
  free: 'Free',
  starter: 'Starter ($17/mo)',
  pro: 'Pro ($34/mo)',
  enterprise: 'Enterprise ($120/mo)',
};

// ============================================================
//  HELPERS
// ============================================================
async function findUser(email) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

async function findUserById(id) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', id)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

async function resetUsageIfNeeded(user) {
  const now = new Date();
  const resetDate = new Date(user.monthly_reset_date);
  if (now >= resetDate) {
    const nextMonth = new Date(now);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    await supabase
      .from('users')
      .update({
        usage_count: 0,
        monthly_reset_date: nextMonth.toISOString().split('T')[0],
      })
      .eq('id', user.id);
    user.usage_count = 0;
    user.monthly_reset_date = nextMonth.toISOString().split('T')[0];
  }
  return user;
}

function getLimit(tier) {
  return TIER_LIMITS[tier] || 200;
}

// ============================================================
//  AUTH MIDDLEWARE
// ============================================================
const auth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await findUserById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ============================================================
//  AUTH ROUTES
// ============================================================
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const existing = await findUser(email);
  if (existing) return res.status(400).json({ error: 'Email already exists' });

  const hashed = await bcrypt.hash(password, 10);
  const now = new Date();
  const nextMonth = new Date(now);
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  const { data, error } = await supabase.from('users').insert({
    email,
    password_hash: hashed,
    tier: 'free',
    usage_count: 0,
    monthly_reset_date: nextMonth.toISOString().split('T')[0],
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ message: 'User created' });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await findUser(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

app.get('/api/user/profile', auth, async (req, res) => {
  const user = await resetUsageIfNeeded(req.user);
  const limit = getLimit(user.tier);
  res.json({
    email: user.email,
    tier: user.tier,
    tier_name: TIER_NAMES[user.tier] || 'Free',
    usage_count: user.usage_count,
    limit: limit,
    monthly_reset_date: user.monthly_reset_date,
  });
});

// ============================================================
//  CHAT WITH GROQ (Free, Fast, Claude‑like)
// ============================================================
app.post('/api/chat/stream', auth, async (req, res) => {
  let user = req.user;
  user = await resetUsageIfNeeded(user);

  const limit = getLimit(user.tier);
  if (user.usage_count >= limit) {
    return res.status(403).json({
      error: `You've reached your monthly limit of ${limit} messages. Upgrade to continue.`,
      tier: user.tier,
      limit: limit,
      used: user.usage_count,
    });
  }

  const { messages } = req.body;

  const systemPrompt = `You are a helpful, concise, and professional AI assistant for TechNovaphy.
You answer questions about IT, web development, cloud, and business technology.
Be direct, use bullet points when helpful, and keep responses clear and actionable.`;

  const groqMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: m.content }))
  ];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: groqMessages,
        stream: true,
      }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const text = json.choices[0]?.delta?.content || '';
            if (text) {
              res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
            }
          } catch (e) {}
        }
      }
    }

    await supabase
      .from('users')
      .update({ usage_count: user.usage_count + 1 })
      .eq('id', user.id);

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Groq error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    res.end();
  }
});

// ============================================================
//  STRIPE CHECKOUT (Idempotent)
// ============================================================
const PRICE_IDS = {
  starter: 'price_starter_17',
  pro: 'price_pro_34',
  enterprise: 'price_enterprise_120',
};

app.post('/api/create-checkout', auth, async (req, res) => {
  const { idempotencyKey, tier } = req.body;
  const user = req.user;

  if (!tier || !['starter', 'pro', 'enterprise'].includes(tier)) {
    return res.status(400).json({ error: 'Invalid tier selected' });
  }

  const { data: existing, error } = await supabase
    .from('payments')
    .select('*')
    .eq('transaction_id', idempotencyKey)
    .maybeSingle();

  if (existing) {
    if (existing.status === 'completed') return res.json({ alreadyProcessed: true });
    return res.status(409).json({ error: 'Payment is being processed' });
  }

  const stripe = require('stripe')(STRIPE_SECRET_KEY);
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{ price: PRICE_IDS[tier], quantity: 1 }],
    mode: 'subscription',
    success_url: 'https://your-frontend.com/dashboard?success=true',
    cancel_url: 'https://your-frontend.com/dashboard?canceled=true',
    client_reference_id: user.id,
    customer_email: user.email,
    metadata: { idempotencyKey, tier },
  });

  await supabase.from('payments').insert({
    user_id: user.id,
    transaction_id: idempotencyKey,
    amount: tier === 'starter' ? 1700 : tier === 'pro' ? 3400 : 12000,
    currency: 'USD',
    status: 'pending',
  });

  res.json({ url: session.url });
});

// ============================================================
//  STRIPE WEBHOOK
// ============================================================
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const stripe = require('stripe')(STRIPE_SECRET_KEY);
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;
    const tier = session.metadata.tier || 'pro';

    await supabase
      .from('payments')
      .update({ status: 'completed' })
      .eq('transaction_id', session.metadata.idempotencyKey);

    await supabase
      .from('users')
      .update({ tier: tier, usage_count: 0 })
      .eq('id', userId);

    console.log(`✅ User ${userId} upgraded to ${tier}`);
  }

  res.json({ received: true });
});

// ============================================================
//  START SERVER
// ============================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));