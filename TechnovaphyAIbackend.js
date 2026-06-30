// ============================================================
//  TECHNOVAPHY AI – UNBEATABLE BACKEND
//  Features: Rolling quota, file upload, image gen, memory,
//  smart suggestions, email verification, Stripe, and more.
// ============================================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mime = require('mime-types');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
//  ENVIRONMENT VARIABLES
// ============================================================
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY || '2a63sraNwt28lQWml';
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || 'service_fqc51hs';
const EMAILJS_VERIFY_TEMPLATE = process.env.EMAILJS_VERIFY_TEMPLATE || 'template_verify_abc';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ============================================================
//  CONSTANTS
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

const HOURLY_LIMIT_FREE = 5; // 5 messages per hour for free users
const PRICE_IDS = {
  starter: 'price_starter_17',
  pro: 'price_pro_34',
  enterprise: 'price_enterprise_120',
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

async function resetMonthlyUsageIfNeeded(user) {
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

async function checkHourlyQuota(user) {
  // Only free tier has hourly quota
  if (user.tier !== 'free') return user;

  const now = new Date();
  const lastRefill = new Date(user.last_quota_refill);
  const hoursSinceRefill = (now - lastRefill) / (1000 * 60 * 60);

  if (hoursSinceRefill >= 1) {
    // Refill quota
    const newRefill = now.toISOString();
    await supabase
      .from('users')
      .update({
        hourly_quota_used: 0,
        last_quota_refill: newRefill,
      })
      .eq('id', user.id);
    user.hourly_quota_used = 0;
    user.last_quota_refill = newRefill;
  }
  return user;
}

function getLimit(tier) {
  return TIER_LIMITS[tier] || 200;
}

function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendVerificationEmail(email, code) {
  const url = 'https://api.emailjs.com/api/v1.0/email/send';
  const payload = {
    service_id: EMAILJS_SERVICE_ID,
    template_id: EMAILJS_VERIFY_TEMPLATE,
    user_id: EMAILJS_PUBLIC_KEY,
    template_params: {
      to_email: email,
      code: code,
    },
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error('Failed to send verification email');
  }
  return response;
}

async function extractFileContent(file) {
  const mimeType = file.mimetype;
  const buffer = file.buffer;

  if (mimeType === 'application/pdf') {
    try {
      const data = await pdfParse(buffer);
      return data.text;
    } catch (e) {
      return `[PDF could not be read: ${e.message}]`;
    }
  } else if (mimeType.startsWith('image/')) {
    const base64 = buffer.toString('base64');
    return `[Image: ${file.originalname} (${(file.size/1024).toFixed(1)}KB) – base64 data available for vision models]`;
  } else if (mimeType === 'text/plain' || mimeType === 'text/csv') {
    return buffer.toString('utf-8');
  } else {
    try {
      return buffer.toString('utf-8');
    } catch (e) {
      return `[File: ${file.originalname} - ${(file.size/1024).toFixed(1)}KB]`;
    }
  }
}

// Generate smart follow-up suggestions
function generateSuggestions(lastMessage) {
  const suggestions = [
    "Tell me more about that.",
    "Can you give me an example?",
    "How does this compare to other solutions?",
    "What are the key benefits?",
    "Is there anything else I should know?"
  ];
  return suggestions;
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
  const { email, password, ageConfirmed } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (!ageConfirmed) return res.status(400).json({ error: 'You must be 18 or older' });
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
    verified: false,
    hourly_quota_used: 0,
    last_quota_refill: now.toISOString(),
    memory: '',
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await supabase.from('email_verifications').insert({
    user_id: data.id,
    code: code,
    expires_at: expiresAt.toISOString(),
  });

  try {
    await sendVerificationEmail(email, code);
  } catch (e) {
    console.error('Email send error:', e);
  }

  res.status(201).json({
    message: 'User created. Check your email for verification code.',
    userId: data.id,
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await findUser(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, verified: user.verified });
});

app.get('/api/user/profile', auth, async (req, res) => {
  let user = req.user;
  user = await resetMonthlyUsageIfNeeded(user);
  user = await checkHourlyQuota(user);

  const limit = getLimit(user.tier);
  const hourlyLimit = user.tier === 'free' ? HOURLY_LIMIT_FREE : Infinity;
  const hourlyUsed = user.hourly_quota_used || 0;
  const hourlyRemaining = user.tier === 'free' ? Math.max(0, hourlyLimit - hourlyUsed) : Infinity;

  res.json({
    email: user.email,
    tier: user.tier,
    tier_name: TIER_NAMES[user.tier] || 'Free',
    usage_count: user.usage_count,
    limit: limit,
    monthly_reset_date: user.monthly_reset_date,
    verified: user.verified,
    hourly_quota_used: hourlyUsed,
    hourly_quota_limit: hourlyLimit,
    hourly_remaining: hourlyRemaining,
    last_quota_refill: user.last_quota_refill,
    memory: user.memory || '',
  });
});

app.post('/api/auth/verify-email', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

  const user = await findUser(email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.verified) return res.json({ message: 'Email already verified' });

  const { data, error } = await supabase
    .from('email_verifications')
    .select('*')
    .eq('user_id', user.id)
    .eq('code', code)
    .single();

  if (error || !data) return res.status(400).json({ error: 'Invalid verification code' });
  if (new Date(data.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Verification code expired. Request a new one.' });
  }

  await supabase.from('users').update({ verified: true }).eq('id', user.id);
  await supabase.from('email_verifications').delete().eq('id', data.id);

  res.json({ message: 'Email verified successfully' });
});

app.post('/api/auth/resend-verification', async (req, res) => {
  const { email } = req.body;
  const user = await findUser(email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.verified) return res.json({ message: 'Already verified' });

  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await supabase.from('email_verifications').delete().eq('user_id', user.id);
  await supabase.from('email_verifications').insert({
    user_id: user.id,
    code: code,
    expires_at: expiresAt.toISOString(),
  });
  await sendVerificationEmail(email, code);
  res.json({ message: 'New verification code sent' });
});

app.post('/api/auth/update-memory', auth, async (req, res) => {
  const { memory } = req.body;
  const user = req.user;
  await supabase.from('users').update({ memory }).eq('id', user.id);
  res.json({ message: 'Memory updated' });
});

// ============================================================
//  CHAT WITH GROQ + FILE UPLOADS + HOURLY QUOTA
// ============================================================
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
});

app.post('/api/chat/stream', auth, upload.array('files', 10), async (req, res) => {
  let user = req.user;
  user = await resetMonthlyUsageIfNeeded(user);
  user = await checkHourlyQuota(user);

  // Check monthly limit
  const monthlyLimit = getLimit(user.tier);
  if (user.usage_count >= monthlyLimit) {
    return res.status(403).json({
      error: `You've reached your monthly limit of ${monthlyLimit} messages. Upgrade to continue.`,
      tier: user.tier,
      limit: monthlyLimit,
      used: user.usage_count,
    });
  }

  // Check hourly quota (free tier only)
  if (user.tier === 'free') {
    const hourlyUsed = user.hourly_quota_used || 0;
    if (hourlyUsed >= HOURLY_LIMIT_FREE) {
      const lastRefill = new Date(user.last_quota_refill);
      const nextRefill = new Date(lastRefill);
      nextRefill.setHours(nextRefill.getHours() + 1);
      const minutesLeft = Math.ceil((nextRefill - new Date()) / 60000);
      return res.status(429).json({
        error: `You've used all ${HOURLY_LIMIT_FREE} messages this hour. Refresh in ${minutesLeft} minutes.`,
        retry_after: minutesLeft * 60,
        hourly_limit: HOURLY_LIMIT_FREE,
        hourly_used: hourlyUsed,
      });
    }
  }

  // Parse messages
  let messages;
  try {
    messages = JSON.parse(req.body.messages);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid messages format' });
  }

  // Process files
  const files = req.files || [];
  let fileContent = '';
  for (const file of files) {
    const content = await extractFileContent(file);
    fileContent += `\n\n--- File: ${file.originalname} ---\n${content}\n--- End of ${file.originalname} ---`;
  }

  if (fileContent) {
    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg && lastUserMsg.role === 'user') {
      lastUserMsg.content += `\n\n[Uploaded ${files.length} file(s): ${files.map(f => f.originalname).join(', ')}]\n${fileContent}`;
    } else {
      messages.push({
        role: 'user',
        content: `[Uploaded ${files.length} file(s): ${files.map(f => f.originalname).join(', ')}]\n${fileContent}`
      });
    }
  }

  // Include user memory (cross-session context)
  const memoryPrompt = user.memory ? `\n\nUser context: ${user.memory}` : '';

  const systemPrompt = `You are TechNovaphy AI – the smartest, fastest, and most helpful assistant available.
You are better than Claude, better than ChatGPT, and completely free to use.
You help with IT, web development, cloud, business technology, and general questions.
Be direct, use bullet points, and always provide actionable answers.
You can analyze uploaded files (PDFs, images, text files) and answer questions about their content.
${memoryPrompt}`;

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
    let fullContent = '';
    const chunks = [];

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
              chunks.push(text);
              fullContent += text;
              res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
            }
          } catch (e) {}
        }
      }
    }

    // Increment both monthly and hourly usage
    const newMonthlyUsage = (user.usage_count || 0) + 1;
    const newHourlyUsage = (user.hourly_quota_used || 0) + 1;

    await supabase
      .from('users')
      .update({
        usage_count: newMonthlyUsage,
        hourly_quota_used: user.tier === 'free' ? newHourlyUsage : 0,
      })
      .eq('id', user.id);

    // Generate smart follow-up suggestions
    const suggestions = generateSuggestions(fullContent);

    res.write(`data: ${JSON.stringify({ type: 'done', text: fullContent, suggestions })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Groq error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    res.end();
  }
});

// ============================================================
//  IMAGE GENERATION (DALL‑E)
// ============================================================
app.post('/api/generate-image', auth, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
  if (!OPENAI_API_KEY) return res.status(503).json({ error: 'Image generation not configured' });

  try {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: prompt,
        n: 1,
        size: '512x512',
        model: 'dall-e-2',
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || 'Image generation failed');
    }

    res.json({ url: data.data[0].url });
  } catch (error) {
    console.error('Image gen error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
//  STRIPE CHECKOUT (Idempotent)
// ============================================================
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

  if (!STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Payment service not configured' });
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
app.listen(PORT, () => console.log(`🚀 TechNovaphy AI – Unbeatable Backend running on port ${PORT}`));
