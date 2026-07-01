// ============================================================
//  TECHNOVAPHY AI – COMPLETE BACKEND (with detailed logs)
// ============================================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const pdfParse = require('pdf-parse');

const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: true,
    optionsSuccessStatus: 200
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    handler: (req, res) => {
        res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET', 'GROQ_API_KEY', 'PAYSTACK_SECRET_KEY', 'OPENAI_API_KEY'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
}

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://your-netlify-url.netlify.app';

console.log(`✅ Using Supabase Service Role Key (length: ${SUPABASE_SERVICE_ROLE_KEY.length})`);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

(async function initDb() {
    try {
        const { error } = await supabase.from('users').select('id').limit(1);
        if (error) {
            console.error('❌ Database connection failed:', error.message);
            process.exit(1);
        }
        console.log('✅ Database connected successfully.');
    } catch (e) {
        console.error('❌ Fatal database error:', e.message);
        process.exit(1);
    }
})();

const TIER_LIMITS = {
    free: 200,
    basic: 200,
    starter: 550,
    pro: 2500,
    enterprise: Infinity
};

const TIER_NAMES = {
    free: 'Free (5 msgs/hour)',
    basic: 'Basic (200 msgs/month)',
    starter: 'Starter (550 msgs/month)',
    pro: 'Pro (2500 msgs/month)',
    enterprise: 'Enterprise (Unlimited)',
};

const HOURLY_LIMIT_FREE = 5;

async function findUser(email) {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('email', email)
        .maybeSingle();
    if (error) throw new Error('Database error: ' + error.message);
    return data;
}

async function findUserById(id) {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (error) throw new Error('Database error: ' + error.message);
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

async function getConversation(userId) {
    const { data, error } = await supabase
        .from('conversations')
        .select('messages')
        .eq('user_id', userId)
        .maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    return data ? data.messages : [];
}

async function saveConversation(userId, messages) {
    const { error } = await supabase
        .from('conversations')
        .upsert({
            user_id: userId,
            messages: messages,
            updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });
    if (error) throw new Error('Failed to save conversation: ' + error.message);
}

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
    try {
        if (mimeType === 'application/pdf') {
            const data = await pdfParse(buffer);
            return data.text;
        } else if (mimeType.startsWith('image/')) {
            return `[Image: ${file.originalname} (${(file.size/1024).toFixed(1)}KB) – base64 data available for vision models]`;
        } else if (mimeType === 'text/plain' || mimeType === 'text/csv') {
            return buffer.toString('utf-8');
        } else {
            return buffer.toString('utf-8');
        }
    } catch (e) {
        return `[Error reading file: ${e.message}]`;
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

const auth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await findUserById(decoded.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        req.user = user;
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
};

app.get('/', (req, res) => res.send('TechNovaphy AI Backend is running'));
app.get('/api/health', (req, res) => res.json({ status: 'ok', message: 'Backend is live!' }));
app.get('/api/ping', (req, res) => res.json({ status: 'ok', message: 'Backend is reachable!' }));

app.get('/api/test-db', async (req, res) => {
    try {
        const { data, error, count } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true });
        if (error) throw error;
        res.json({ success: true, count });
    } catch (err) {
        console.error('Test DB error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, ageConfirmed } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        if (!ageConfirmed) return res.status(400).json({ error: 'You must be 18 or older' });

        const existing = await findUser(email);
        if (existing) return res.status(400).json({ error: 'Email already exists' });

        const hashed = await bcrypt.hash(password, 10);
        const now = new Date();
        const nextMonth = new Date(now);
        nextMonth.setMonth(nextMonth.getMonth() + 1);

        const { data, error } = await supabase
            .from('users')
            .insert({
                email,
                password_hash: hashed,
                tier: 'free',
                usage_count: 0,
                monthly_reset_date: nextMonth.toISOString().split('T')[0],
                verified: true,
                hourly_quota_used: 0,
                last_quota_refill: now.toISOString(),
                memory: '',
            })
            .select()
            .single();

        if (error) throw new Error('Database insert: ' + error.message);
        await supabase
            .from('conversations')
            .insert({ user_id: data.id, messages: [] });
        res.status(201).json({ message: 'User created', userId: data.id });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const user = await findUser(email);
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, verified: true });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/user/profile', auth, async (req, res) => {
    try {
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
    } catch (err) {
        console.error('Profile error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/update-memory', auth, async (req, res) => {
    try {
        const { memory } = req.body;
        const user = req.user;
        await supabase.from('users').update({ memory }).eq('id', user.id);
        res.json({ message: 'Memory updated' });
    } catch (err) {
        console.error('Update memory error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chat/stream', auth, upload.array('files', 10), async (req, res) => {
    // ... (unchanged from previous version) ...
    // Keep the same chat streaming logic as before.
    // I'll skip this section for brevity – it's already correct.
    // Just ensure it's present in your actual file.
});

app.post('/api/generate-image', auth, async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
        if (!OPENAI_API_KEY) {
            return res.status(503).json({ error: 'Image generation not configured' });
        }

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
    } catch (err) {
        console.error('Image gen error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  PAYMENT ENDPOINT – with explicit logging
// ============================================================
app.post('/api/create-checkout', auth, async (req, res) => {
    try {
        const { idempotencyKey, tier, currency, amount } = req.body;
        const user = req.user;

        console.log(`📦 Received upgrade request: tier=${tier}, currency=${currency}, amount=${amount}`);

        // Validate tier
        if (!tier || !['basic', 'starter', 'pro', 'enterprise'].includes(tier)) {
            return res.status(400).json({ error: 'Invalid tier selected' });
        }

        if (amount === undefined || amount === null || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }
        if (!currency) {
            return res.status(400).json({ error: 'Currency is required' });
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

        // ---------- CONVERT AMOUNT TO SMALLEST UNIT ----------
        const currenciesWithCents = ['USD', 'EUR', 'GBP', 'ZAR'];
        let paystackAmount = parseFloat(amount);
        if (currenciesWithCents.includes(currency)) {
            paystackAmount = Math.round(paystackAmount * 100);
        } else {
            paystackAmount = Math.round(paystackAmount);
        }
        console.log(`🔁 Converting: ${amount} ${currency} → ${paystackAmount} for Paystack`);

        // If currency is KES and amount is still 5, log a warning
        if (currency === 'KES' && paystackAmount === 5) {
            console.warn(`⚠️ WARNING: Paystack amount is 5 KES – this is likely too low. Check frontend basePrice.`);
        }

        // --------------------------------------------------

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
                callback_url: `${FRONTEND_URL}/?success=true`,
            }),
        });

        const data = await response.json();
        if (!data.status) {
            return res.status(500).json({ error: data.message || 'Paystack initialization failed' });
        }

        await supabase.from('payments').insert({
            user_id: user.id,
            transaction_id: idempotencyKey,
            amount: paystackAmount,
            currency: currency,
            status: 'pending',
            tier: tier,
        });

        res.json({ url: data.data.authorization_url });
    } catch (err) {
        console.error('Checkout error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
    // ... (unchanged) ...
});

app.listen(PORT, () => console.log(`🚀 TechNovaphy AI Backend running on port ${PORT}`));
