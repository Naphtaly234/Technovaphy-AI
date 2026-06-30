// ============================================================
//  TECHNOVAPHY AI – BACKEND (ORIGINAL, WORKING + CORS FIX)
// ============================================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const pdfParse = require('pdf-parse');

const app = express();

// ============================================================
//  1. CORS – WIDE OPEN (allows any origin)
// ============================================================
app.use(cors()); // ✅ This is the fix – now your frontend can connect

// ============================================================
//  2. MIDDLEWARE (same as original)
// ============================================================
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Rate limiting – returns JSON instead of plain text
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
  },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ============================================================
//  3. ENVIRONMENT VARIABLES
// ============================================================
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ============================================================
//  4. CONSTANTS
// ============================================================
const TIER_LIMITS = {
  free: 200,
  starter: 550,
  pro: 2500,
  enterprise: Infinity,
};

const TIER_NAMES = {
  free: 'Free (5 msgs/hour)',
  starter: 'Starter ($17/mo) – 550 msg',
  pro: 'Pro ($34/mo) – 2,500 msg',
  enterprise: 'Enterprise ($120/mo) – Unlimited',
};

const HOURLY_LIMIT_FREE = 5;

// ============================================================
//  5. HELPERS (exactly as they were)
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
  if (user.tier !== 'free') return user;
  const now = new Date();
  const lastRefill = new Date(user.last_quota_refill);
  const hoursSinceRefill = (now - lastRefill) / (1000 * 60 * 60);
  if (hoursSinceRefill >= 1) {
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

// File upload security
const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf',
    'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type'), false);
  }
};
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: fileFilter,
});

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

function generateSuggestions(lastMessage) {
  return [
    "Tell me more about that.",
    "Can you give me an example?",
    "How does this compare to other solutions?",
    "What are the key benefits?",
    "Is there anything else I should know?"
  ];
}

// ============================================================
//  6. AUTH MIDDLEWARE
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
//  7. HEALTH CHECK & ROOT
// ============================================================
app.get('/', (req, res) => {
  res.send('TechNovaphy AI Backend is running');
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'TechNovaphy AI backend is live!' });
});

// ============================================================
//  8. AUTH ROUTES
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
    verified: true,
    hourly_quota_used: 0,
    last_quota_refill: now.toISOString(),
    memory: '',
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ message: 'User created', userId: data.id });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await findUser(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, verified: true });
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
    verified: true,
    hourly_quota_used: hourlyUsed,
    hourly_quota_limit: hourlyLimit,
    hourly_remaining: hourlyRemaining,
    last_quota_refill: user.last_quota_refill,
    memory: user.memory || '',
  });
});

app.post('/api/auth/update-memory', auth, async (req, res) => {
  const { memory } = req.body;
  const user = req.user;
  await supabase.from('users').update({ memory }).eq('id', user.id);
  res.json({ message: 'Memory updated' });
});

// ============================================================
//  9. CHAT STREAM
// ============================================================
app.post('/api/chat/stream', auth, upload.array('files', 10), async (req, res) => {
  let user = req.user;
  user = await resetMonthlyUsageIfNeeded(user);
  user = await checkHourlyQuota(user);

  const monthlyLimit = getLimit(user.tier);
  if (user.usage_count >= monthlyLimit) {
    return res.status(403).json({
      error: `You've reached your monthly limit of ${monthlyLimit} messages. Upgrade to continue.`,
      tier: user.tier,
      limit: monthlyLimit,
      used: user.usage_count,
    });
  }

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

  let messages;
  try {
    messages = JSON.parse(req.body.messages);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid messages format' });
  }

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
              fullContent += text;
              res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
            }
          } catch (e) {}
        }
      }
    }

    const newMonthlyUsage = (user.usage_count || 0) + 1;
    const newHourlyUsage = (user.hourly_quota_used || 0) + 1;
    await supabase
      .from('users')
      .update({
        usage_count: newMonthlyUsage,
        hourly_quota_used: user.tier === 'free' ? newHourlyUsage : 0,
      })
      .eq('id', user.id);

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
//  10. IMAGE GENERATION (DALL‑E)
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
    if (!response.ok) throw new Error(data.error?.message || 'Image generation failed');
    res.json({ url: data.data[0].url });
  } catch (error) {
    console.error('Image gen error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
//  11. PAYMENT – Paystack Checkout (Idempotent)
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

  if (!PAYSTACK_SECRET_KEY) {
    return res.status(503).json({ error: 'Payment service not configured' });
  }

  const tierPrices = {
    starter: 1700,
    pro: 3400,
    enterprise: 12000,
  };

  const response = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: user.email,
      amount: tierPrices[tier],
      currency: 'USD',
      metadata: {
        idempotencyKey: idempotencyKey,
        tier: tier,
        userId: user.id,
      },
      callback_url: process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/dashboard?success=true` : 'https://graceful-marshmallow-d90826.netlify.app/?success=true',
    }),
  });

  const data = await response.json();
  if (!data.status) {
    return res.status(500).json({ error: data.message || 'Paystack initialization failed' });
  }

  await supabase.from('payments').insert({
    user_id: user.id,
    transaction_id: idempotencyKey,
    amount: tierPrices[tier],
    currency: 'USD',
    status: 'pending',
  });

  res.json({ url: data.data.authorization_url });
});

// ============================================================
//  12. PAYSTACK WEBHOOK
// ============================================================
app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const payload = req.body;

  const event = payload.event;
  const data = payload.data;

  if (event === 'charge.success') {
    const metadata = data.metadata || {};
    const userId = metadata.userId;
    const tier = metadata.tier || 'pro';
    const idempotencyKey = metadata.idempotencyKey;

    if (userId) {
      await supabase
        .from('payments')
        .update({ status: 'completed' })
        .eq('transaction_id', idempotencyKey);

      await supabase
        .from('users')
        .update({ tier: tier, usage_count: 0 })
        .eq('id', userId);

      console.log(`✅ User ${userId} upgraded to ${tier}`);
    }
  }

  res.sendStatus(200);
});

// ============================================================
//  13. START SERVER
// ============================================================
app.listen(PORT, () => console.log(`🚀 TechNovaphy AI Backend running on port ${PORT}`));
