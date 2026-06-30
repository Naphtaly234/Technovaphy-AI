// server.js – Complete backend with Groq + Supabase + Stripe + File Upload + Image Gen + Email Verification
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
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;  // optional

// EmailJS settings
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY || '2a63sraNwt28lQWml';
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || 'service_fqc51hs';
const EMAILJS_VERIFY_TEMPLATE = process.env.EMAILJS_VERIFY_TEMPLATE || 'template_verify_abc'; // ← update with your template ID

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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
//  EMAIL VERIFICATION HELPERS
// ============================================================
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

// ============================================================
//  FILE EXTRACTION HELPER
// ============================================================
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
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Generate and store verification code
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
  const { error: codeError } = await supabase.from('email_verifications').insert({
    user_id: data.id,
    code: code,
    expires_at: expiresAt.toISOString(),
  });
  if (codeError) {
    console.error('Code insertion error:', codeError);
  }

  // Send verification email (don't block response)
  try {
    await sendVerificationEmail(email, code);
  } catch (e) {
    console.error('Email send error:', e);
    // but we still return success, user can resend code later.
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
  const user = await resetUsageIfNeeded(req.user);
  const limit = getLimit(user.tier);
  res.json({
    email: user.email,
    tier: user.tier,
    tier_name: TIER_NAMES[user.tier] || 'Free',
    usage_count: user.usage_count,
    limit: limit,
    monthly_reset_date: user.monthly_reset_date,
    verified: user.verified,
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

  // Mark user as verified
  await supabase.from('users').update({ verified: true }).eq('id', user.id);
  // Delete verification record
  await supabase.from('email_verifications').delete().eq('id', data.id);

  res.json({ message: 'Email verified successfully' });
});

app.post('/api/auth/resend-verification', async (req, res) => {
  const { email } = req.body;
  const user = await findUser(email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.verified) return res.json({ message: 'Already verified' });

  // Generate new code
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  // Delete old code
  await supabase.from('email_verifications').delete().eq('user_id', user.id);
  // Insert new
  await supabase.from('email_verifications').insert({
    user_id: user.id,
    code: code,
    expires_at: expiresAt.toISOString(),
  });
  await sendVerificationEmail(email, code);
  res.json({ message: 'New verification code sent' });
});

// ============================================================
//  CHAT WITH GROQ (Free, Fast, Claude‑like) + FILE UPLOADS
// ============================================================
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

app.post('/api/chat/stream', auth, upload.array('files', 5), async (req, res) => {
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

  // Parse messages from form data
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
      lastUserMsg.content += `\n\n[User uploaded ${files.length} file(s): ${files.map(f => f.originalname).join(', ')}]\n${fileContent}`;
    } else {
      messages.push({
        role: 'user',
        content: `[Uploaded ${files.length} file(s): ${files.map(f => f.originalname).join(', ')}]\n${fileContent}`
      });
    }
  }

  const systemPrompt = `You are a helpful, concise, and professional AI assistant for TechNovaphy.
You can analyze uploaded files (PDFs, images, text files) and answer questions about their content.
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
//  IMAGE GENERATION ENDPOINT (OpenAI DALL‑E)
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
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
