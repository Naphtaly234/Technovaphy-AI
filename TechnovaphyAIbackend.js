// ============================================================
//  TECHNOVAPHY AI – PRODUCTION BACKEND
//  - AI failover (OpenRouter, valid models only)
//  - Admin dashboard, last_active tracking
//  - Static route for admin.html
//  - Payment integrations: Paystack (card, bank, M‑Pesa, Airtel Money)
//  - ALL USER-FACING ERROR MESSAGES SANITIZED
//  - Code runner: web languages + Python (Pyodide‑ready)
//  - Smart system prompt: Technovaphy AI with company knowledge
// ============================================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');

// ---- Redis (optional) ----
let redisClient = null;
let redisAvailable = false;
try {
    const redis = require('redis');
    if (process.env.REDIS_URL) {
        redisClient = redis.createClient({ url: process.env.REDIS_URL });
        redisClient.on('error', () => { redisAvailable = false; });
        redisClient.connect().then(() => { redisAvailable = true; }).catch(() => { redisAvailable = false; });
    }
} catch (e) {}

const app = express();
app.set('trust proxy', 1);

app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: true,
    optionsSuccessStatus: 200
}));

// ---- Environment checks (only the absolute essentials) ----
const required = [
    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET',
    'OPENROUTER_API_KEY', 'PAYSTACK_SECRET_KEY'
];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
    console.error('❌ Missing essential env variables:', missing.join(', '));
    process.exit(1);
}

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://your-frontend.netlify.app';
const OWNER_EMAIL = process.env.OWNER_EMAIL || null;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---- Database init ----
(async function initDb() {
    try {
        const { error } = await supabase.from('users').select('id').limit(1);
        if (error) console.warn('⚠️ DB connection issue:', error.message);
        else console.log('✅ Database connected.');
    } catch (e) {
        console.warn('⚠️ Could not connect to Supabase:', e.message);
    }
})();

// ---- PAYSTACK WEBHOOK ----
app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['x-paystack-signature'];
        if (!signature) return res.sendStatus(401);
        const expectedHash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
        if (expectedHash !== signature) return res.sendStatus(401);
        const payload = JSON.parse(req.body.toString('utf8'));
        const event = payload.event;
        const data = payload.data;
        if (event === 'charge.success') {
            const metadata = data.metadata || {};
            const userId = metadata.userId;
            const idempotencyKey = metadata.idempotencyKey;
            const type = metadata.type;
            const paystackStatus = data.status;
            if (paystackStatus !== 'success') return res.sendStatus(200);
            const { data: paymentRecord } = await supabase.from('payments').select('*').eq('transaction_id', idempotencyKey).maybeSingle();
            if (!paymentRecord || paymentRecord.status === 'completed') return res.sendStatus(200);
            await supabase.from('payments').update({ status: 'completed' }).eq('transaction_id', idempotencyKey);
            if (userId) {
                if (type === 'code_runner') {
                    await supabase.from('users').update({ code_runner_unlocked: true }).eq('id', userId);
                    console.log(`✅ Code runner unlocked for user ${userId} (payment verified)`);
                } else {
                    const tier = metadata.tier || 'pro';
                    await supabase.from('users').update({ tier: tier, usage_count: 0 }).eq('id', userId);
                    console.log(`✅ User ${userId} upgraded to ${tier} (payment verified)`);
                }
            }
        }
        res.sendStatus(200);
    } catch (err) {
        console.error('Webhook error:', err);
        res.sendStatus(500);
    }
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    handler: (req, res) => res.status(429).json({ error: 'Too many attempts. Please try again later.' })
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ============================================================
//  CONSTANTS
// ============================================================
const TIER_PRICES_KES = { starter: 200, pro: 1700, enterprise: 17000, ultimate: 100000 };
const TIER_LIMITS = { free: 200, starter: 200, pro: 2500, enterprise: Infinity, ultimate: 1000000 };
const TIER_NAMES = { free: 'Free', starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise', ultimate: 'Ultimate' };
const TIER_FEATURES = {
    free: ['200 messages / month', 'Standard models', 'Community support'],
    starter: ['200 messages / month', 'Priority queueing', 'Email support'],
    pro: ['2,500 messages / month', 'All AI models', 'Priority support'],
    enterprise: ['Unlimited messages', 'All AI models', 'Dedicated support'],
    ultimate: ['Unlimited messages', 'Early access to new models', 'White-glove support']
};
const CODE_RUNNER_PRICE_KES = 1000;
const MAX_CONVERSATION_HISTORY = 20;

// ---- Payment channels declared simply, just like bank and PesaLink ----
const PAYMENT_CHANNELS = {
    KE: {
        country: 'Kenya',
        currency: 'KES',
        displayNames: {
            'card': '💳 Card',
            'bank_transfer': '🏦 Bank Transfer',
            'mpesa': '📱 M-Pesa',
            'mobile_money': '📱 Airtel Money'
        }
    },
    NG: {
        country: 'Nigeria',
        currency: 'NGN',
        displayNames: {
            'card': '💳 Card',
            'bank_transfer': '🏦 Bank Transfer',
            'ussd': '📞 USSD',
            'bank': '📱 Mobile Banking'
        }
    },
    GH: {
        country: 'Ghana',
        currency: 'GHS',
        displayNames: {
            'card': '💳 Card',
            'bank_transfer': '🏦 Bank Transfer'
        }
    },
    UG: {
        country: 'Uganda',
        currency: 'UGX',
        displayNames: {
            'card': '💳 Card',
            'bank_transfer': '🏦 Bank Transfer'
        }
    },
    TZ: {
        country: 'Tanzania',
        currency: 'TZS',
        displayNames: {
            'card': '💳 Card',
            'bank_transfer': '🏦 Bank Transfer'
        }
    }
};

// ============================================================
//  SYSTEM PROMPT – Technovaphy AI (Smart & Disciplined)
// ============================================================
function buildSystemPrompt({ memoryPrompt, languageInstruction }) {
    return `You are TechNovaphy AI, the official, highly intelligent assistant of TechNovaphy Solutions (https://technovaphy-solutions-5nz6.onrender.com). You are precise, disciplined, and thorough. You never hallucinate. You only provide information that you are highly confident about, and you always distinguish fact from opinion or uncertainty. When you don't know something, you clearly say "I don't know" and, if applicable, point the user to authoritative sources or the company's website.

🔗 COMPANY KNOWLEDGE – TechNovaphy Solutions:
- Based in Nairobi, Kenya, serving 500+ businesses across East Africa.
- Core services: Managed IT Operations (99.9% uptime guarantee), Business Software (custom ERPs, automated workflows), Cloud Solutions (data migration, automated backups), 24/7 Technical Support, and Web Development (business websites, e‑commerce, web apps, PWAs, admin dashboards, APIs).
- Technology stack: HTML5, CSS3, JavaScript, React, TypeScript, Tailwind CSS, Node.js, Express.js, Python, Flask, Java, Spring Boot, PostgreSQL, MySQL, MongoDB, SQL Server, Redis, Firebase, Docker, Render, Vercel, AWS, Cloudflare.

📋 SUPPORT PLANS (prices in KES):
- Website Maintenance: Bronze (KSh 10k/mo), Silver (KSh 20k/mo), Gold (KSh 35k/mo).
- IT Support Plans: Standard IT (KSh 15k/mo), Managed Pro (KSh 50k/mo), Premium Website (one‑time KSh 120k).
- Free IT Infrastructure Audit (worth KES 50,000) available on the website.

When discussing the company, always mention the website: https://technovaphy-solutions-5nz6.onrender.com. For detailed plan features, direct the user there.

🧠 BEHAVIOUR & TONE:
- Be smart, analytical, and concise. No filler words, no marketing fluff.
- If the user asks a complex or research‑oriented question, leverage your training data to provide a well‑structured, evidence‑based answer. If appropriate, suggest where the user can verify the information (e.g., official documentation, reputable sites).
- Always separate your reasoning from the final answer using the <thinking> / <answer> tags.
- For code, provide clean, working examples and explain them.
- For legal/financial matters, include a disclaimer: "This is for informational purposes only, not professional advice."
- If the user's language preference is provided, respond in that language.

${memoryPrompt}
${languageInstruction}`;
}

function parseThinkingAndAnswer(rawText) {
    const thinkClosed = rawText.match(/<thinking>([\s\S]*?)<\/thinking>/i);
    const thinkOpen = rawText.match(/<thinking>([\s\S]*)$/i);
    const answerClosed = rawText.match(/<answer>([\s\S]*?)<\/answer>/i);
    const answerOpen = rawText.match(/<answer>([\s\S]*)$/i);

    let thinking = '', answer = '';
    if (thinkClosed) thinking = thinkClosed[1];
    else if (thinkOpen && !answerOpen) thinking = thinkOpen[1];
    if (answerClosed) answer = answerClosed[1];
    else if (answerOpen) answer = answerOpen[1];

    if (!answer) {
        if (thinkClosed) {
            const afterThinking = rawText.slice(rawText.indexOf(thinkClosed[0]) + thinkClosed[0].length).trim();
            if (afterThinking) answer = afterThinking;
        }
        if (!answer && rawText.trim()) {
            answer = rawText.replace(/<\/?thinking>/gi, '').replace(/<\/?answer>/gi, '').trim();
        }
    }
    return { thinking: thinking.trim(), answer: answer.trim() };
}

// ============================================================
//  AI FAILOVER CHAIN (OpenRouter) – valid models only
// ============================================================
async function fetchAIResponseWithFailover(messages, userSelectedModel) {
    if (!OPENROUTER_API_KEY) {
        const err = new Error('AI service unavailable.');
        err.safeMessage = 'AI service is not configured. Please contact support.';
        throw err;
    }

    const modelMap = {
        'openai/gpt-4o-mini': 'openai/gpt-4o-mini',
        'anthropic/claude-haiku-4.5': 'anthropic/claude-haiku-4.5',
        'google/gemini-2.0-flash-001': 'google/gemini-2.0-flash-001',
        'meta-llama/llama-4-maverick:free': 'meta-llama/llama-4-maverick:free'
    };

    const primary = modelMap[userSelectedModel] || 'openai/gpt-4o-mini';
    const fallbacks = [
        'openai/gpt-4o-mini',
        'anthropic/claude-haiku-4.5',
        'google/gemini-2.0-flash-001',
        'meta-llama/llama-4-maverick:free'
    ];
    const modelsToTry = [primary, ...fallbacks.filter(m => m !== primary)];

    let lastError = null;
    for (const model of modelsToTry) {
        try {
            console.log(`🔄 Attempting OpenRouter (${model})...`);
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://technovaphy.ai'
                },
                body: JSON.stringify({
                    model: model,
                    messages: messages,
                    temperature: 0.7,
                    top_p: 0.9,
                    stream: true,
                    max_tokens: 2000
                })
            });

            if (response.ok) {
                console.log(`✅ OpenRouter succeeded with ${model}`);
                return { response, source: model };
            }

            const errText = await response.text();
            let errorMessage = `OpenRouter error (${model}): ${response.status}`;
            try {
                const errJson = JSON.parse(errText);
                if (errJson.error) {
                    errorMessage += ` - ${errJson.error.message || JSON.stringify(errJson.error)}`;
                } else {
                    errorMessage += ` - ${errText}`;
                }
            } catch (e) {
                errorMessage += ` - ${errText}`;
            }
            console.warn(`⚠️ ${model} failed: ${errorMessage}`);
            lastError = new Error(errorMessage);
        } catch (err) {
            console.warn(`⚠️ ${model} error: ${err.message}`);
            lastError = err;
        }
    }

    const safeErr = new Error('All AI models are currently unavailable.');
    safeErr.internal = lastError?.message;
    throw safeErr;
}

// ============================================================
//  HELPERS (sanitized)
// ============================================================
async function findUser(email) {
    const { data, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
    if (error) {
        console.error('DB findUser error:', error);
        throw new Error('A temporary issue occurred. Please try again.');
    }
    return data;
}
async function findUserById(id) {
    const { data, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
    if (error) {
        console.error('DB findUserById error:', error);
        throw new Error('A temporary issue occurred. Please try again.');
    }
    return data;
}
function getLimit(tier) { return TIER_LIMITS[tier] || 200; }
async function getConversation(userId) {
    const { data, error } = await supabase.from('conversations').select('messages').eq('user_id', userId).maybeSingle();
    if (error && error.code !== 'PGRST116') {
        console.error('DB getConversation error:', error);
        throw new Error('Unable to load conversation history.');
    }
    return data ? data.messages : [];
}
async function saveConversation(userId, messages) {
    const { error } = await supabase.from('conversations').upsert({
        user_id: userId,
        messages: messages,
        updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) {
        console.error('DB saveConversation error:', error);
        throw new Error('Failed to save conversation.');
    }
}

// ---- Rate limiting (Redis or memory) ----
const inMemoryRate = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 10;

async function checkRateLimit(userId) {
    if (redisAvailable && redisClient) {
        const key = `rate:${userId}`;
        const count = await redisClient.incr(key);
        if (count === 1) await redisClient.expire(key, 60);
        return count <= RATE_LIMIT_MAX;
    } else {
        const now = Date.now();
        if (!inMemoryRate.has(userId)) {
            inMemoryRate.set(userId, [now]);
            return true;
        }
        const timestamps = inMemoryRate.get(userId);
        const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
        if (recent.length >= RATE_LIMIT_MAX) return false;
        recent.push(now);
        inMemoryRate.set(userId, recent);
        return true;
    }
}

if (!redisAvailable) {
    setInterval(() => {
        const now = Date.now();
        for (const [userId, timestamps] of inMemoryRate) {
            const filtered = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
            if (filtered.length === 0) inMemoryRate.delete(userId);
            else inMemoryRate.set(userId, filtered);
        }
    }, 60 * 1000);
}

// ---- Concurrency ----
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_REQUESTS) || 10000;
let activeRequests = 0;
const concurrencyQueue = [];

function acquireConcurrency() {
    return new Promise((resolve) => {
        if (activeRequests < MAX_CONCURRENT) {
            activeRequests++;
            resolve();
        } else {
            concurrencyQueue.push(resolve);
        }
    });
}

function releaseConcurrency() {
    activeRequests--;
    if (concurrencyQueue.length > 0) {
        const next = concurrencyQueue.shift();
        activeRequests++;
        next();
    }
}

// ============================================================
//  AUTH MIDDLEWARE (updates last_active)
// ============================================================
const auth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Authentication required. Please log in.' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await findUserById(decoded.userId);
        if (!user) return res.status(401).json({ error: 'Account not found.' });
        req.user = user;
        await supabase.from('users').update({ last_active: new Date().toISOString() }).eq('id', user.id);
        next();
    } catch (e) {
        console.error('Auth error:', e);
        res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
};

// ============================================================
//  PUBLIC ROUTES
// ============================================================
app.get('/', (req, res) => res.send('TechNovaphy AI Backend'));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/ping', (req, res) => res.json({ status: 'ok' }));

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/test-key', async (req, res) => {
    try {
        if (!OPENROUTER_API_KEY) {
            return res.status(400).json({ error: 'API key not configured.' });
        }
        const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
            headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` }
        });
        const data = await response.json();
        if (response.ok) {
            res.json({ valid: true, credits: data.credits || 'unknown' });
        } else {
            res.status(response.status).json({ valid: false, error: 'Key validation failed.' });
        }
    } catch (err) {
        console.error('Test key error:', err);
        res.status(500).json({ error: 'Unable to verify API key.' });
    }
});

// ---- Register ----
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, ageConfirmed, country } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
        if (!ageConfirmed) return res.status(400).json({ error: 'You must confirm you are 18 years or older.' });
        if (!country || !PAYMENT_CHANNELS[country]) return res.status(400).json({ error: 'Please select a valid country.' });

        const existing = await findUser(email);
        if (existing) return res.status(400).json({ error: 'An account with this email already exists.' });

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
            free_session_start: now.toISOString(),
            memory: '',
            role: 'user',
            country: country,
            code_runner_unlocked: false,
            last_active: now.toISOString()
        }).select().single();

        if (error) {
            console.error('Registration DB error:', error);
            return res.status(500).json({ error: 'Account creation failed. Please try again.' });
        }
        await supabase.from('conversations').insert({ user_id: data.id, messages: [] });

        console.log(`✅ User registered from ${country}`);
        res.status(201).json({ message: 'Account created successfully.', userId: data.id, country: country });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Something went wrong during registration.' });
    }
});

// ---- Login ----
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

        const user = await findUser(email);
        if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid email or password.' });

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        await supabase.from('users').update({ last_active: new Date().toISOString() }).eq('id', user.id);
        res.json({ token, verified: true, country: user.country });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Unable to log in. Please try again later.' });
    }
});

// ---- Profile ----
app.get('/api/user/profile', auth, async (req, res) => {
    try {
        const user = req.user;
        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL);
        const limit = isOwner ? Infinity : getLimit(user.tier);
        res.json({
            email: user.email,
            tier: user.tier,
            tier_name: TIER_NAMES[user.tier] || 'Free',
            usage_count: user.usage_count,
            limit: limit,
            verified: true,
            country: user.country || 'KE',
            code_runner_unlocked: isOwner ? true : (user.code_runner_unlocked || false),
            is_owner: isOwner
        });
    } catch (err) {
        console.error('Profile error:', err);
        res.status(500).json({ error: 'Could not load profile.' });
    }
});

// ---- Update Memory ----
app.post('/api/auth/update-memory', auth, async (req, res) => {
    try {
        const { memory } = req.body;
        await supabase.from('users').update({ memory }).eq('id', req.user.id);
        res.json({ message: 'Memory updated successfully.' });
    } catch (err) {
        console.error('Update memory error:', err);
        res.status(500).json({ error: 'Failed to update memory.' });
    }
});

// ============================================================
//  CONVERSATIONS (CRUD)
// ============================================================
app.get('/api/conversations', auth, async (req, res) => {
    try {
        const user = req.user;
        const { data, error } = await supabase
            .from('conversations')
            .select('id, user_id, created_at, updated_at, messages')
            .eq('user_id', user.id)
            .order('updated_at', { ascending: false });

        if (error) throw error;

        const withSummary = (data || []).map(conv => {
            const firstUserMsg = conv.messages?.find(m => m.role === 'user');
            const summary = firstUserMsg?.content?.substring(0, 50) + '...' || 'Untitled';
            return {
                id: conv.id,
                created_at: conv.created_at,
                updated_at: conv.updated_at,
                summary: summary
            };
        });

        res.json({ conversations: withSummary });
    } catch (err) {
        console.error('Get conversations error:', err);
        res.status(500).json({ error: 'Failed to load conversations.' });
    }
});

app.get('/api/conversations/:conversationId', auth, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const { data, error } = await supabase
            .from('conversations')
            .select('*')
            .eq('id', conversationId)
            .eq('user_id', req.user.id)
            .single();

        if (error || !data) return res.status(404).json({ error: 'Conversation not found.' });
        res.json({ conversation: data });
    } catch (err) {
        console.error('Get conversation error:', err);
        res.status(500).json({ error: 'Failed to load conversation.' });
    }
});

app.post('/api/conversations', auth, async (req, res) => {
    try {
        const { data: existing, error: findError } = await supabase
            .from('conversations')
            .select('*')
            .eq('user_id', req.user.id)
            .maybeSingle();

        if (findError && findError.code !== 'PGRST116') throw findError;

        if (existing) {
            return res.status(200).json({ conversation: existing });
        }

        const { data, error } = await supabase.from('conversations').insert({
            user_id: req.user.id,
            messages: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }).select().single();

        if (error) throw error;
        res.status(201).json({ conversation: data });
    } catch (err) {
        console.error('Create conversation error:', err);
        res.status(500).json({ error: 'Could not create conversation.' });
    }
});

app.delete('/api/conversations/:conversationId', auth, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const { error } = await supabase.from('conversations').delete()
            .eq('id', conversationId)
            .eq('user_id', req.user.id);

        if (error) throw error;
        res.json({ message: 'Conversation deleted.' });
    } catch (err) {
        console.error('Delete conversation error:', err);
        res.status(500).json({ error: 'Failed to delete conversation.' });
    }
});

app.post('/api/conversations/clear', auth, async (req, res) => {
    try {
        const { data: existing, error: findError } = await supabase
            .from('conversations')
            .select('*')
            .eq('user_id', req.user.id)
            .maybeSingle();

        if (findError && findError.code !== 'PGRST116') throw findError;

        if (!existing) {
            const { data, error } = await supabase.from('conversations').insert({
                user_id: req.user.id,
                messages: [],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }).select().single();
            if (error) throw error;
            return res.status(201).json({ conversation: data });
        }

        const { data, error } = await supabase
            .from('conversations')
            .update({ messages: [], updated_at: new Date().toISOString() })
            .eq('id', existing.id)
            .select()
            .single();

        if (error) throw error;
        res.json({ conversation: data });
    } catch (err) {
        console.error('Clear conversation error:', err);
        res.status(500).json({ error: 'Failed to clear conversation.' });
    }
});

// ============================================================
//  PROJECTS (CRUD)
// ============================================================
app.get('/api/projects', auth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('projects')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ projects: data || [] });
    } catch (err) {
        console.error('Get projects error:', err);
        res.status(500).json({ error: 'Failed to load projects.' });
    }
});

app.post('/api/projects', auth, async (req, res) => {
    try {
        const { name, description } = req.body;
        if (!name) return res.status(400).json({ error: 'Please enter a project name.' });
        const { data, error } = await supabase.from('projects').insert({
            user_id: req.user.id,
            name,
            description: description || '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }).select().single();
        if (error) throw error;
        res.status(201).json({ project: data });
    } catch (err) {
        console.error('Create project error:', err);
        res.status(500).json({ error: 'Could not create project.' });
    }
});

app.put('/api/projects/:id', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description } = req.body;
        if (!name) return res.status(400).json({ error: 'Project name is required.' });
        const { data, error } = await supabase.from('projects')
            .update({ name, description, updated_at: new Date().toISOString() })
            .eq('id', id)
            .eq('user_id', req.user.id)
            .select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Project not found.' });
        res.json({ project: data });
    } catch (err) {
        console.error('Update project error:', err);
        res.status(500).json({ error: 'Failed to update project.' });
    }
});

app.delete('/api/projects/:id', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('projects')
            .delete()
            .eq('id', id)
            .eq('user_id', req.user.id);
        if (error) throw error;
        res.json({ message: 'Project deleted.' });
    } catch (err) {
        console.error('Delete project error:', err);
        res.status(500).json({ error: 'Failed to delete project.' });
    }
});

// ============================================================
//  CHAT STREAM (with failover and safe user messages)
// ============================================================
app.post('/api/chat/stream', auth, async (req, res) => {
    try {
        const user = req.user;
        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL);

        if (!isOwner) await acquireConcurrency();
        if (!isOwner && !await checkRateLimit(user.id)) {
            releaseConcurrency();
            return res.status(429).json({ error: 'You are sending messages too quickly. Please wait a moment.' });
        }
        const monthlyLimit = getLimit(user.tier);
        if (!isOwner && user.usage_count >= monthlyLimit) {
            releaseConcurrency();
            return res.status(403).json({ error: 'You have reached your monthly message limit.' });
        }

        let conversation = await getConversation(user.id);
        let newMessages;
        try { newMessages = JSON.parse(req.body.messages); } catch (e) {
            releaseConcurrency();
            return res.status(400).json({ error: 'Invalid message format.' });
        }
        conversation = conversation.concat(newMessages);
        if (conversation.length > MAX_CONVERSATION_HISTORY) {
            conversation = conversation.slice(-MAX_CONVERSATION_HISTORY);
        }

        if (!isOwner) {
            await supabase.from('users').update({ usage_count: (user.usage_count || 0) + 1 }).eq('id', user.id);
        }

        const language = req.body.language || 'auto';
        let languageInstruction = '';
        if (language !== 'auto') {
            languageInstruction = `\n\nRespond in **${language}**.\n`;
        }
        const memoryPrompt = user.memory ? `\n\nUser context: ${user.memory}` : '';
        const systemPrompt = buildSystemPrompt({ memoryPrompt, languageInstruction });

        const groqMessages = [{ role: 'system', content: systemPrompt }, ...conversation];
        const userModel = req.body.model || 'openai/gpt-4o-mini';

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const originalEnd = res.end;
        res.end = function(...args) {
            releaseConcurrency();
            originalEnd.apply(res, args);
        };

        let aiResponse, source;
        try {
            const result = await fetchAIResponseWithFailover(groqMessages, userModel);
            aiResponse = result.response;
            source = result.source;
        } catch (err) {
            console.error('All AI models failed:', err.message);
            await saveConversation(user.id, conversation);
            res.write(`data: ${JSON.stringify({
                type: 'error',
                message: 'AI is temporarily unavailable. Please try again shortly.'
            })}\n\n`);
            res.end();
            return;
        }

        if (!aiResponse.ok) {
            const errText = await aiResponse.text();
            console.error('OpenRouter non‑ok response:', errText);
            await saveConversation(user.id, conversation);
            res.write(`data: ${JSON.stringify({
                type: 'error',
                message: 'AI service encountered an error. Please try again later.'
            })}\n\n`);
            res.end();
            return;
        }

        const reader = aiResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', rawContent = '';

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
                            rawContent += text;
                            const { thinking, answer } = parseThinkingAndAnswer(rawContent);
                            if (answer) {
                                res.write(`data: ${JSON.stringify({ type: 'chunk', text: answer })}\n\n`);
                            }
                        }
                    } catch (e) {}
                }
            }
        }

        const { thinking: finalThinking, answer: finalAnswer } = parseThinkingAndAnswer(rawContent);
        const finalText = finalAnswer || rawContent || 'No response generated.';
        conversation.push({ role: 'assistant', content: finalText });
        await saveConversation(user.id, conversation);

        res.write(`data: ${JSON.stringify({
            type: 'done',
            text: finalText,
            model: source
        })}\n\n`);
        res.end();

    } catch (err) {
        console.error('Chat stream error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'An unexpected error occurred while processing your message.' });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'An unexpected error occurred.' })}\n\n`);
            res.end();
        }
        releaseConcurrency();
    }
});

// ============================================================
//  EXCHANGE RATES
// ============================================================
let exchangeRates = { KES: 1 };
let ratesLastFetched = 0;
async function fetchExchangeRates() {
    const now = Date.now();
    if (now - ratesLastFetched < 60 * 60 * 1000) return exchangeRates;
    try {
        const response = await fetch('https://api.exchangerate-api.com/v4/latest/KES');
        const data = await response.json();
        exchangeRates = data.rates;
        exchangeRates.KES = 1;
        ratesLastFetched = now;
    } catch (err) {
        console.warn('⚠️ Exchange rate fetch failed');
        exchangeRates = { KES: 1, NGN: 12.5, GHS: 18.5, UGX: 3700, TZS: 2600 };
    }
    return exchangeRates;
}

// ============================================================
//  PRICING
// ============================================================
app.get('/api/pricing', auth, async (req, res) => {
    try {
        const user = req.user;
        const countryCode = user.country || 'KE';
        const countryInfo = PAYMENT_CHANNELS[countryCode] || PAYMENT_CHANNELS['KE'];
        const currency = countryInfo.currency;
        const rates = await fetchExchangeRates();
        const rate = currency === 'KES' ? 1 : (rates[currency] || 1);

        const tiers = Object.keys(TIER_PRICES_KES).map(tier => ({
            tier,
            name: TIER_NAMES[tier],
            amount: Math.round(TIER_PRICES_KES[tier] * rate),
            currency,
            features: TIER_FEATURES[tier] || [],
            limit: TIER_LIMITS[tier] === Infinity ? 'Unlimited' : TIER_LIMITS[tier]
        }));

        const codeRunner = {
            amount: Math.round(CODE_RUNNER_PRICE_KES * rate),
            currency,
            interval: 'monthly'
        };

        res.json({
            currentTier: user.tier,
            codeRunnerUnlocked: user.code_runner_unlocked || false,
            tiers,
            codeRunner,
            channels: countryInfo.channels ? Object.keys(countryInfo.displayNames) : ['card', 'bank_transfer'],
            country: countryCode
        });
    } catch (err) {
        console.error('Pricing error:', err);
        res.status(500).json({ error: 'Could not load pricing information.' });
    }
});

// ============================================================
//  PAYMENT STATUS
// ============================================================
app.get('/api/payment-status/:key', auth, async (req, res) => {
    try {
        const { key } = req.params;
        const { data, error } = await supabase
            .from('payments')
            .select('status, tier, currency, amount')
            .eq('transaction_id', key)
            .eq('user_id', req.user.id)
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Payment record not found.' });

        res.json({
            status: data.status,
            tier: data.tier,
            currency: data.currency,
            amount: data.amount
        });
    } catch (err) {
        console.error('Payment status error:', err);
        res.status(500).json({ error: 'Unable to check payment status.' });
    }
});

// ============================================================
//  TIER UPGRADE CHECKOUT (Paystack – channels sent explicitly)
// ============================================================
app.post('/api/create-checkout', auth, async (req, res) => {
    try {
        const { idempotencyKey, tier } = req.body;
        const user = req.user;
        if (!idempotencyKey) return res.status(400).json({ error: 'Missing payment reference.' });
        if (!tier || !['starter', 'pro', 'enterprise', 'ultimate'].includes(tier)) {
            return res.status(400).json({ error: 'Invalid subscription tier selected.' });
        }

        const countryCode = user.country || 'KE';
        const countryInfo = PAYMENT_CHANNELS[countryCode] || PAYMENT_CHANNELS['KE'];
        const finalCurrency = countryInfo.currency;

        let humanAmount = TIER_PRICES_KES[tier];
        if (finalCurrency !== 'KES') {
            const rates = await fetchExchangeRates();
            const rate = rates[finalCurrency] || rates.NGN;
            humanAmount = Math.round(TIER_PRICES_KES[tier] * rate);
        }
        const amount = Math.round(humanAmount * 100);

        const { data: existing } = await supabase.from('payments').select('*').eq('transaction_id', idempotencyKey).maybeSingle();
        if (existing) {
            if (existing.status === 'completed') return res.json({ alreadyProcessed: true });
            return res.status(409).json({ error: 'A payment is already being processed for this transaction.' });
        }

        if (!PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Payment service is not available at the moment.' });

        // ---- Build channels from displayNames (just like bank and PesaLink) ----
        let channels = ['card', 'bank_transfer'];
        if (countryInfo.displayNames) {
            for (const ch of Object.keys(countryInfo.displayNames)) {
                if (!channels.includes(ch)) channels.push(ch);
            }
        }
        console.log('🔗 Sending channels to Paystack:', channels);

        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: user.email,
                amount: amount,
                currency: finalCurrency,
                channels: channels,
                metadata: { idempotencyKey, tier, userId: user.id, country: countryCode },
                callback_url: `${FRONTEND_URL}/?success=true&key=${idempotencyKey}`
            })
        });
        const data = await response.json();
        if (!data.status) {
            console.error('Paystack init error:', data);
            return res.status(502).json({ error: 'Payment initialization failed. Please try again.' });
        }

        await supabase.from('payments').insert({
            user_id: user.id,
            transaction_id: idempotencyKey,
            amount: amount,
            currency: finalCurrency,
            status: 'pending',
            tier,
            country: countryCode
        });

        res.json({ url: data.data.authorization_url, amount: humanAmount, currency: finalCurrency });
    } catch (err) {
        console.error('Checkout error:', err);
        res.status(500).json({ error: 'Unable to start payment process. Please try again later.' });
    }
});

// ============================================================
//  CODE RUNNER SUBSCRIPTION
// ============================================================
app.post('/api/subscribe-code', auth, async (req, res) => {
    try {
        const { idempotencyKey } = req.body;
        const user = req.user;
        if (!idempotencyKey) return res.status(400).json({ error: 'Missing payment reference.' });

        if (user.code_runner_unlocked) {
            return res.status(200).json({
                alreadyActive: true,
                message: 'You already have an active Code Runner subscription.'
            });
        }

        const countryCode = user.country || 'KE';
        const countryInfo = PAYMENT_CHANNELS[countryCode] || PAYMENT_CHANNELS['KE'];
        const currency = countryInfo.currency;
        const rates = await fetchExchangeRates();
        const rate = currency === 'KES' ? 1 : (rates[currency] || 1);
        const humanAmount = Math.round(CODE_RUNNER_PRICE_KES * rate);
        const amountInMinor = Math.round(humanAmount * 100);

        const { data: existing } = await supabase.from('payments').select('*').eq('transaction_id', idempotencyKey).maybeSingle();
        if (existing) {
            if (existing.status === 'completed') return res.json({ alreadyProcessed: true });
            return res.status(409).json({ error: 'A payment is already being processed.' });
        }

        const planName = `TechNovaphy Code Runner (${currency} ${humanAmount})`;
        let planCode = null;

        try {
            const listPlans = await fetch('https://api.paystack.co/plan?perPage=50', {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
            });
            const planData = await listPlans.json();
            if (planData.status) {
                const match = planData.data.find(p => p.name === planName && p.amount === amountInMinor && p.currency === currency);
                if (match) planCode = match.plan_code;
            }
        } catch (e) {}

        if (!planCode) {
            const createPlan = await fetch('https://api.paystack.co/plan', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: planName,
                    amount: amountInMinor,
                    currency: currency,
                    interval: 'monthly',
                    description: 'Monthly subscription to unlock code runner'
                })
            });
            const planData = await createPlan.json();
            if (planData.status) {
                planCode = planData.data.plan_code;
            } else {
                console.error('Paystack plan creation error:', planData);
                return res.status(502).json({ error: 'Unable to set up subscription at this time.' });
            }
        }

        // ---- Build channels from displayNames ----
        let channels = ['card', 'bank_transfer'];
        if (countryInfo.displayNames) {
            for (const ch of Object.keys(countryInfo.displayNames)) {
                if (!channels.includes(ch)) channels.push(ch);
            }
        }

        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: user.email,
                amount: amountInMinor,
                currency: currency,
                channels: channels,
                plan: planCode,
                metadata: {
                    userId: user.id,
                    idempotencyKey,
                    country: countryCode,
                    type: 'code_runner'
                },
                callback_url: `${FRONTEND_URL}/?success=true&key=${idempotencyKey}`
            })
        });
        const data = await response.json();

        if (!data.status) {
            console.error('Paystack subscribe error:', data);
            return res.status(502).json({ error: 'Payment initialization failed. Please try again.' });
        }

        await supabase.from('payments').insert({
            user_id: user.id,
            transaction_id: idempotencyKey,
            amount: amountInMinor,
            currency: currency,
            status: 'pending',
            tier: 'code_runner',
            country: countryCode
        });

        res.json({ url: data.data.authorization_url, amount: humanAmount, currency: currency, subscription: true });
    } catch (err) {
        console.error('Code subscription error:', err.message);
        res.status(500).json({ error: 'Unable to process subscription. Please try again later.' });
    }
});

// ============================================================
//  CODE ANALYSIS – web languages + Python (Pyodide‑ready, auto‑detect)
// ============================================================
app.post('/api/run-code', auth, async (req, res) => {
    try {
        const user = req.user;
        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL);

        if (!isOwner) await acquireConcurrency();
        if (!isOwner && !user.code_runner_unlocked) {
            releaseConcurrency();
            return res.status(403).json({ error: 'Please subscribe to Code Runner to run code.', lock: true });
        }

        const { language, version, code } = req.body;
        if (!code) {
            releaseConcurrency();
            return res.status(400).json({ error: 'Please provide some code.' });
        }

        const webLangs = ['html', 'css', 'javascript', 'js', 'typescript', 'ts'];
        const pythonLangs = ['python', 'py'];
        const allAllowed = [...webLangs, ...pythonLangs];
        let langNormalized = (language || '').toLowerCase().trim();

        if (!allAllowed.includes(langNormalized)) {
            const looksLikePython = /\b(print|def |import |class |elif |try:|except |from |lambda |__name__)\b/.test(code);
            if (looksLikePython) {
                langNormalized = 'python';
            } else {
                releaseConcurrency();
                return res.status(400).json({ error: 'This editor supports HTML, CSS, JavaScript, TypeScript, and Python.' });
            }
        }

        const isPython = pythonLangs.includes(langNormalized);
        const languageName = isPython ? 'Python' : langNormalized.toUpperCase();

        const systemPrompt = isPython
            ? `You are an expert Python developer. Analyze the following Python code and provide:
1. A brief explanation of what the code does.
2. Any potential bugs, logical errors, or best‑practice violations.
3. Suggestions for improvement (performance, readability, Pythonic style).
4. If the code would produce output, describe what it would print or return.

Be clear and concise. No markdown, just plain text with line breaks.

CODE:
\`\`\`python
${code}
\`\`\``
            : `You are an expert web development assistant. Analyze the following ${languageName} code snippet and provide:
1. A brief summary of what the code does.
2. Any potential issues, bugs, or best‑practice violations.
3. Suggestions for improvement (performance, accessibility, semantics).
4. If applicable, describe the expected visual output or behaviour in a browser.

Be clear and concise. No markdown, just plain text with line breaks.

CODE:
\`\`\`${langNormalized}
${code}
\`\`\``;

        const messages = [{ role: 'system', content: systemPrompt }];

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://technovaphy.ai'
            },
            body: JSON.stringify({
                model: 'openai/gpt-4o-mini',
                messages: messages,
                temperature: 0.7,
                stream: true,
                max_tokens: 2000
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('Code analysis API error:', errText);
            throw new Error('Code analysis service is temporarily unavailable.');
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', fullContent = '';

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
                            res.write(`data: ${JSON.stringify({ type: 'chunk', text: fullContent })}\n\n`);
                        }
                    } catch (e) {}
                }
            }
        }

        res.write(`data: ${JSON.stringify({ type: 'done', text: fullContent })}\n\n`);
        res.end();
        releaseConcurrency();

    } catch (err) {
        console.error('Code execution error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to analyze code. Please try again later.' });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'Code analysis failed. Please try again later.' })}\n\n`);
            res.end();
        }
        releaseConcurrency();
    }
});

// ============================================================
//  ADMIN DASHBOARD ROUTES
// ============================================================
app.get('/api/admin/stats', auth, async (req, res) => {
    try {
        const user = req.user;
        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL);
        if (!isOwner) {
            return res.status(403).json({ error: 'Access restricted to administrators.' });
        }

        const { count: totalUsers, error: usersErr } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true });
        if (usersErr) throw usersErr;

        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        let activeUsers = 0;
        const { count: activeCount, error: activeErr } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true })
            .gte('last_active', twentyFourHoursAgo);
        if (activeErr) {
            const { count: fallbackCount, error: fallbackErr } = await supabase
                .from('users')
                .select('*', { count: 'exact', head: true })
                .gte('created_at', twentyFourHoursAgo);
            if (fallbackErr) throw fallbackErr;
            activeUsers = fallbackCount || 0;
        } else {
            activeUsers = activeCount || 0;
        }

        const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        let loggedInUsers = 0;
        const { count: loggedCount, error: loggedErr } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true })
            .gte('last_active', fifteenMinutesAgo);
        if (!loggedErr) {
            loggedInUsers = loggedCount || 0;
        }

        const { data: payments, error: payErr } = await supabase
            .from('payments')
            .select('amount, currency, tier, status, created_at')
            .eq('status', 'completed');
        if (payErr) throw payErr;

        const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0);
        const revenueByTier = {};
        payments.forEach(p => {
            revenueByTier[p.tier] = (revenueByTier[p.tier] || 0) + p.amount;
        });

        const { data: recentPayments, error: recentErr } = await supabase
            .from('payments')
            .select('amount, currency, tier, status, created_at, user_id')
            .eq('status', 'completed')
            .order('created_at', { ascending: false })
            .limit(5);
        if (recentErr) throw recentErr;

        const { count: codeRunnerCount, error: codeErr } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true })
            .eq('code_runner_unlocked', true);
        if (codeErr) throw codeErr;

        res.json({
            totalUsers: totalUsers || 0,
            activeUsers: activeUsers || 0,
            loggedInUsers: loggedInUsers || 0,
            totalRevenue: totalRevenue || 0,
            revenueByTier: revenueByTier || {},
            recentPayments: recentPayments || [],
            codeRunnerCount: codeRunnerCount || 0,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('Admin stats error:', err);
        res.status(500).json({ error: 'Unable to load dashboard statistics.' });
    }
});

app.get('/api/admin/users', auth, async (req, res) => {
    try {
        const user = req.user;
        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL);
        if (!isOwner) {
            return res.status(403).json({ error: 'Access restricted to administrators.' });
        }

        const { data, error } = await supabase
            .from('users')
            .select('id, email, tier, usage_count, code_runner_unlocked, created_at, last_active')
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) throw error;
        res.json({ users: data || [] });
    } catch (err) {
        console.error('Admin users error:', err);
        res.status(500).json({ error: 'Failed to load user list.' });
    }
});

// ============================================================
//  GLOBAL ERROR HANDLER (catches any uncaught errors)
// ============================================================
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'An unexpected problem occurred. Please try again later.' });
});

// ============================================================
//  START
// ============================================================
app.listen(PORT, () => console.log(`🚀 TechNovaphy AI running on port ${PORT}`));
