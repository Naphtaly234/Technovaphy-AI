// ============================================================
//  TECHNOVAPHY AI – FINAL MVP BACKEND (4 TIERS, MULTI-CURRENCY)
//  FIXED: Paystack calculation logic
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
//  1. CORS – PERMISSIVE
// ============================================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.options('*', cors());

// ============================================================
//  2. SECURITY & LOGGING
// ============================================================
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Rate limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Please try again later.',
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
//  4. CONSTANTS – 4 TIERS + 2.5hr FREE WINDOW
// ============================================================
const TIER_LIMITS = {
  free: 200,
  basic: 200,
  starter: 550,
  pro: 2500,
  enterprise: Infinity,
};

const TIER_NAMES = {
  free: 'Free (20 msgs / 2.5h)',
  basic: 'Basic (500 KES/mo) – 200 msg',
  starter: 'Starter (1,700 KES/mo) – 550 msg',
  pro: 'Pro (3,500 KES/mo) – 2,500 msg',
  enterprise: 'Enterprise (15,000 KES/mo) – Unlimited',
};

const FREE_WINDOW_LIMIT = 20;
const FREE_WINDOW_HOURS = 2.5;

// ============================================================
//  4a. MULTI‑CURRENCY WITH LIVE EXCHANGE RATES
// ============================================================

// Base prices in KES (your source of truth)
const BASE_PRICES_KES = {
  basic: 500,
  starter: 1700,
  pro: 3500,
  enterprise: 15000,
};

// Currencies where Paystack expects amount in subunits (cents/pence/kobo)
// For these, we multiply by 100 before sending to Paystack
const SUBUNIT_CURRENCIES = ['USD', 'EUR', 'GBP', 'NGN', 'GHS', 'ZAR'];

// Mutable object to hold live exchange rates (1 KES = X target)
// Hardcoded fallback rates that work
let liveExchangeRates = {
  KES: 1,
  USD: 0.0077,
  EUR: 0.0070,
  GBP: 0.0061,
  NGN: 12.5,
  GHS: 0.098,
  ZAR: 0.14,
};

/**
 * Fetch fresh exchange rates from a free API (no key required)
 * Falls back to existing rates on failure.
 */
async function updateExchangeRates() {
  try {
    const response = await fetch('https://api.exchangerate-api.com/v4/latest/KES');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data && data.rates) {
      liveExchangeRates = data.rates; // e.g., { USD: 0.0077, EUR: 0.0070, ... }
      console.log('✅ Exchange rates updated from live API');
    }
  } catch (error) {
    console.error('⚠️ Failed to update exchange rates, using last known rates:', error.message);
  }
}

// Initial fetch, then refresh every 60 minutes
updateExchangeRates();
setInterval(updateExchangeRates, 60 * 60 * 1000);

/**
 * Convert KES base price to target currency display amount.
 * Example: basic tier → 500 KES → 3.85 USD
 */
function convertPrice(tier, targetCurrency) {
  const baseKES = BASE_PRICES_KES[tier];
  if (!baseKES) throw new Error('Invalid tier');
  const rate = liveExchangeRates[targetCurrency];
  if (rate === undefined) throw new Error(`Unsupported currency: ${targetCurrency}`);
  return Math.round(baseKES * rate * 100) / 100;
}

/**
 * Return the amount Paystack expects (subunits for some currencies).
 */
function getPaystackAmount(displayAmount, currency) {
  if (SUBUNIT_CURRENCIES.includes(currency)) {
    return Math.round(displayAmount * 100); // e.g., 385 cents for 3.85 USD
  }
  return Math.round(displayAmount); // KES already in base units
}

// ============================================================
//  5. HELPERS
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

async function checkFreeWindowQuota(user) {
  if (user.tier !== 'free') return user;

  const now = new Date();
  const lastRefill = new Date(user.last_quota_refill);
  const hoursSinceRefill = (now - lastRefill) / (1000 * 60 * 60);

  if (hoursSinceRefill >= FREE_WINDOW_HOURS) {
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

// ============================================================
//  6. FILE UPLOAD CONFIG
// ============================================================
const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf',
    'text/plain', 'text/csv',
    'text/html',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];
  if (file.mimetype.startsWith('text/') || allowedTypes.includes(file.mimetype)) {
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
    return `[Image: ${file.originalname} (${(file.size/1024).toFixed(1)}KB)]`;
  } else if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'text/html') {
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
//  7. AUTH MIDDLEWARE
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
//  8. HEALTH CHECK
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'TechNovaphy AI backend is live!' });
});

// ============================================================
//  9. AUTH ROUTES
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
  user = await checkFreeWindowQuota(user);

  const limit = getLimit(user.tier);
  const windowLimit = user.tier === 'free' ? FREE_WINDOW_LIMIT : Infinity;
  const used = user.hourly_quota_used || 0;
  const remaining = user.tier === 'free' ? Math.max(0, windowLimit - used) : Infinity;

  res.json({
    email: user.email,
    tier: user.tier,
    tier_name: TIER_NAMES[user.tier] || 'Free',
    usage_count: user.usage_count,
    limit: limit,
    monthly_reset_date: user.monthly_reset_date,
    verified: true,
    hourly_quota_used: used,
    hourly_quota_limit: windowLimit,
    hourly_remaining: remaining,
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
//  10. CHAT WITH GROQ
// ============================================================

function detectRoleAndCustomize(userMessage) {
  const msg = userMessage.toLowerCase();
  const roleMap = [
    { keywords: ['react', 'node', 'python', 'java', 'javascript', 'typescript', 'git', 'api', 'backend', 'frontend', 'debug', 'code', 'programming', 'software', 'developer', 'devops', 'docker', 'kubernetes'], role: 'Senior Software Engineer', extra: 'Write clean, production-ready code with edge cases handled. Explain trade-offs. Provide actual code blocks.' },
    { keywords: ['ui', 'ux', 'figma', 'adobe', 'photoshop', 'illustrator', 'typography', 'color palette', 'wireframe', 'prototype', 'user experience', 'user interface', 'design system'], role: 'Principal UX/UI Designer', extra: 'Think about human psychology, accessibility (WCAG), and visual hierarchy. Suggest modern design patterns and tools.' },
    { keywords: ['math', 'statistics', 'calculus', 'algebra', 'probability', 'linear regression', 'hypothesis', 'dataset', 'machine learning', 'neural network', 'algorithm', 'data science'], role: 'Mathematician & Data Scientist', extra: 'Show your reasoning step-by-step. Use mathematical notation (if text-based) and explain the "why" behind formulas.' },
    { keywords: ['cyber', 'security', 'firewall', 'encryption', 'certificate', 'vulnerability', 'penetration', 'owasp', 'zero-trust', 'hack'], role: 'Cybersecurity Architect', extra: 'Prioritize risk assessment, defense-in-depth, and OWASP/ISO standards. Be paranoid but practical.' },
    { keywords: ['cloud', 'aws', 'azure', 'gcp', 'serverless', 's3', 'ec2', 'lambda', 'cloudfront', 'terraform'], role: 'Cloud Solutions Architect', extra: 'Focus on scalability, cost-efficiency, and resilience. Give cloud-agnostic advice when possible.' },
    { keywords: ['strategy', 'marketing', 'sales', 'copywriting', 'business model', 'roi', 'market fit', 'competitor', 'pitch'], role: 'Business & Growth Strategist', extra: 'Be data-driven. Focus on monetization, user acquisition, and clear, persuasive language.' }
  ];
  let detectedRole = 'General Tech Genius';
  let extraInstructions = 'Give clear, structured, and helpful answers. Use bullet points and real-world analogies.';
  for (const item of roleMap) {
    if (item.keywords.some(kw => msg.includes(kw))) {
      detectedRole = item.role;
      extraInstructions = item.extra;
      break;
    }
  }
  return { detectedRole, extraInstructions };
}

app.post('/api/chat/stream', auth, upload.array('files', 10), async (req, res) => {
  let user = req.user;
  user = await resetMonthlyUsageIfNeeded(user);
  user = await checkFreeWindowQuota(user);

  const monthlyLimit = getLimit(user.tier);
  if (user.usage_count >= monthlyLimit) {
    return res.status(403).json({
      error: `You've reached your monthly limit of ${monthlyLimit} messages. Upgrade to continue.`,
      tier: user.tier,
      limit: monthlyLimit,
      used: user.usage_count,
    });
  }

  // FREE TIER: 2.5-HOUR WINDOW CHECK
  if (user.tier === 'free') {
    const used = user.hourly_quota_used || 0;
    if (used >= FREE_WINDOW_LIMIT) {
      const lastRefill = new Date(user.last_quota_refill);
      const resetTime = new Date(lastRefill.getTime() + (FREE_WINDOW_HOURS * 60 * 60 * 1000));
      const minutesLeft = Math.ceil((resetTime - new Date()) / 60000);
      const hoursLeft = Math.floor(minutesLeft / 60);
      const minsLeft = minutesLeft % 60;
      let timeString = '';
      if (hoursLeft > 0) timeString += `${hoursLeft}h `;
      timeString += `${minsLeft}m`;

      return res.status(429).json({
        error: `✨ You've used all ${FREE_WINDOW_LIMIT} messages in this 2.5‑hour window. Your next window unlocks in ${timeString}.`,
        retry_after: minutesLeft * 60,
        window_limit: FREE_WINDOW_LIMIT,
        window_hours: FREE_WINDOW_HOURS,
        used: used,
        unlocks_in_minutes: minutesLeft,
      });
    }
  }

  let messages;
  try {
    messages = JSON.parse(req.body.messages);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid messages format' });
  }

  // --- File handling ---
  const files = req.files || [];
  let fileContent = '';
  let fileNames = [];
  for (const file of files) {
    fileNames.push(file.originalname);
    const content = await extractFileContent(file);
    fileContent += `\n\n--- File: ${file.originalname} ---\n${content}\n--- End of ${file.originalname} ---`;
  }
  if (fileContent) {
    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg && lastUserMsg.role === 'user') {
      lastUserMsg.content += `\n\n[Uploaded ${files.length} file(s): ${fileNames.join(', ')}]\n${fileContent}`;
    } else {
      messages.push({
        role: 'user',
        content: `[Uploaded ${files.length} file(s): ${fileNames.join(', ')}]\n${fileContent}`
      });
    }
  }

  // --- Auto-extract name into memory ---
  const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  if (lastUserMsg) {
    const lower = lastUserMsg.content.toLowerCase();
    const nameMatch = lower.match(/my name is ([^\n.,!?]+)/i) || lower.match(/call me ([^\n.,!?]+)/i);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      let memory = user.memory || '';
      if (!memory.includes('name:')) {
        memory = memory ? `${memory}\nname: ${name}` : `name: ${name}`;
        await supabase.from('users').update({ memory }).eq('id', user.id);
        user.memory = memory;
      }
    }
  }

  // --- Role Detection ---
  const lastUserContent = lastUserMsg ? lastUserMsg.content : '';
  const { detectedRole, extraInstructions } = detectRoleAndCustomize(lastUserContent);

  // --- Build Memory Prompt ---
  let memoryPrompt = '';
  if (user.memory && user.memory.trim() !== '') {
    const staticSuggestions = [
      "Tell me more about that.",
      "Can you give me an example?",
      "How does this compare to other solutions?",
      "What are the key benefits?",
      "Is there anything else I should know?"
    ];
    const isStatic = staticSuggestions.every(s => user.memory.includes(s));
    if (!isStatic) {
      memoryPrompt = `\n\nImportant context about the user: ${user.memory}`;
    }
  }

  // --- Extract name ---
  let userName = 'there';
  if (user.memory && user.memory.includes('name:')) {
    const nameMatch = user.memory.match(/name:\s*([^\n,]+)/i);
    if (nameMatch) userName = nameMatch[1].trim();
  }

  // --- SYSTEM PROMPT ---
  const systemPrompt = `You are TechNovaphy AI, the warmest and most brilliant assistant on the planet.

Current persona: You are acting as a **${detectedRole}**.
${extraInstructions}

Personality rules:
- Address the user as "${userName}" naturally every few replies.
- NEVER say "As an AI..." or "I don't have feelings...". Instead, lean into empathy.
- Match their energy: playful if they are, serious if they are.
- Before diving into technical details, give a brief, warm acknowledgment.
- If they ask for code, provide it. If they ask for math, show the steps. If they ask for design, think visually.

🔍 File Upload Instructions:
- When the user uploads a file, you MUST:
  1. Acknowledge the file(s) by name.
  2. Ask them what they'd like you to do with it.
  3. If they ask a question about the file content, answer it thoroughly.
  4. If they don't specify what they want, proactively ask.

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
        temperature: 0.75,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API error: ${response.status} ${errorText}`);
    }

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
          } catch (e) {
            console.warn('SSE parse error:', e);
          }
        }
      }
    }

    if (!fullContent || fullContent.trim() === '') {
      fullContent = "I'm sorry, I didn't get that. Could you please rephrase your question?";
    }

    const suggestions = [];

    // Update usage
    const newMonthlyUsage = (user.usage_count || 0) + 1;
    const newWindowUsage = (user.hourly_quota_used || 0) + 1;
    await supabase
      .from('users')
      .update({
        usage_count: newMonthlyUsage,
        hourly_quota_used: user.tier === 'free' ? newWindowUsage : 0,
      })
      .eq('id', user.id);

    res.write(`data: ${JSON.stringify({ type: 'done', text: fullContent, suggestions })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Groq error:', error);
    const errorMsg = error.message || 'Internal server error';
    res.write(`data: ${JSON.stringify({ type: 'error', message: errorMsg })}\n\n`);
    res.end();
  }
});

// ============================================================
//  11. IMAGE GENERATION (DALL‑E)
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
//  12. PAYMENT – FIXED Paystack Calculation
// ============================================================
app.post('/api/create-checkout', auth, async (req, res) => {
  const { idempotencyKey, tier, currency = 'KES' } = req.body;
  const user = req.user;

  console.log('📥 Payment request:', { tier, currency, user: user.email });

  // Validate tier
  if (!tier || !['basic', 'starter', 'pro', 'enterprise'].includes(tier)) {
    return res.status(400).json({ error: 'Invalid tier selected' });
  }

  // Validate currency
  if (!liveExchangeRates[currency]) {
    return res.status(400).json({ error: `Unsupported currency: ${currency}` });
  }

  // Check for duplicate idempotency key
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

  // ----- CALCULATION LOGIC (FIXED) -----
  const basePriceKES = BASE_PRICES_KES[tier];
  const exchangeRate = liveExchangeRates[currency];
  
  // Calculate display amount (e.g., 500 KES = 3.85 USD)
  const displayAmount = Math.round(basePriceKES * exchangeRate * 100) / 100;
  
  // Calculate Paystack amount (subunits for non-KES currencies)
  let paystackAmount;
  if (currency === 'KES') {
    paystackAmount = Math.round(displayAmount);
  } else {
    paystackAmount = Math.round(displayAmount * 100);
  }

  // ----- LOGGING FOR DEBUGGING -----
  console.log('💳 PAYMENT CALCULATION:');
  console.log(`   Tier: ${tier}`);
  console.log(`   Base KES price: ${basePriceKES} KES`);
  console.log(`   Exchange rate (1 KES → ${currency}): ${exchangeRate}`);
  console.log(`   Display amount: ${displayAmount} ${currency}`);
  console.log(`   Paystack amount (subunits): ${paystackAmount}`);
  console.log(`   Currency: ${currency}`);

  const response = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: user.email,
      amount: paystackAmount,
      currency: currency,
      metadata: {
        idempotencyKey: idempotencyKey,
        tier: tier,
        userId: user.id,
      },
      callback_url: process.env.FRONTEND_URL
        ? `${process.env.FRONTEND_URL}/dashboard?success=true`
        : 'https://technovaphysai.netlify.app/?success=true',
    }),
  });

  const data = await response.json();
  console.log('📤 Paystack response:', data.status ? 'SUCCESS' : 'FAILED', data.message);

  if (!data.status) {
    return res.status(500).json({ error: data.message || 'Paystack initialization failed' });
  }

  // Store payment record
  await supabase.from('payments').insert({
    user_id: user.id,
    transaction_id: idempotencyKey,
    amount: displayAmount,
    currency: currency,
    status: 'pending',
  });

  res.json({ url: data.data.authorization_url });
});

// ============================================================
//  13. PAYSTACK WEBHOOK
// ============================================================
app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const payload = req.body;
  const event = payload.event;
  const data = payload.data;

  // 🔐 Optional: Verify signature
  // const crypto = require('crypto');
  // const hash = crypto.createHmac('sha256', PAYSTACK_SECRET_KEY).update(JSON.stringify(payload)).digest('hex');
  // if (hash !== signature) return res.status(401).send('Unauthorized');

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
//  14. START SERVER
// ============================================================
app.listen(PORT, () => console.log(`🚀 TechNovaphy AI backend running on port ${PORT}`));
