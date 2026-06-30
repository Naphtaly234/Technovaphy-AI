// ============================================================
//  TECHNOVAPHY AI – BACKEND WITH DB TEST (FINAL)
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

// ============================================================
//  1. CORS
// ============================================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: true,
    optionsSuccessStatus: 200
}));

// ============================================================
//  2. MIDDLEWARE
// ============================================================
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

// ============================================================
//  3. ENVIRONMENT VARIABLES
// ============================================================
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_me';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // MUST BE SET
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    process.exit(1);
}
if (!JWT_SECRET || JWT_SECRET === 'fallback_secret_change_me') {
    console.warn('⚠️ JWT_SECRET is weak – set a strong secret in production');
}
if (!GROQ_API_KEY) {
    console.warn('⚠️ GROQ_API_KEY not set – chat will fail');
}

console.log('✅ Environment variables check passed');
console.log(`✅ Supabase URL: ${SUPABASE_URL}`);
console.log(`✅ Service role key present: ${SUPABASE_SERVICE_ROLE_KEY ? 'Yes' : 'No'}`);

// ============================================================
//  4. SUPABASE CLIENT – USING SERVICE ROLE KEY
// ============================================================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ============================================================
//  5. CONSTANTS & HELPERS (same as before)
// ============================================================
const TIER_LIMITS = { free: 200, starter: 550, pro: 2500, enterprise: Infinity };
const TIER_NAMES = {
    free: 'Free (5 msgs/hour)',
    starter: 'Starter ($17/mo) – 550 msg',
    pro: 'Pro ($34/mo) – 2,500 msg',
    enterprise: 'Enterprise ($120/mo) – Unlimited',
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

// File upload (multer)
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
//  7. PUBLIC ENDPOINTS
// ============================================================
app.get('/', (req, res) => res.send('TechNovaphy AI Backend is running'));
app.get('/api/health', (req, res) => res.json({ status: 'ok', message: 'Backend is live!' }));
app.get('/api/ping', (req, res) => res.json({ status: 'ok', message: 'Backend is reachable!' }));

// ============================================================
//  8. DB TEST ENDPOINT (NO AUTH) – USE THIS TO DEBUG
// ============================================================
app.get('/api/test-db', async (req, res) => {
    try {
        // Try to count rows in users table
        const { data, error, count } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true });
        if (error) throw error;
        res.json({
            success: true,
            message: 'Connected to users table',
            count: count,
            table: 'users',
            schema: 'public'
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
            hint: 'Make sure SUPABASE_SERVICE_ROLE_KEY is set correctly and table "users" exists in public schema.'
        });
    }
});

// ============================================================
//  9. AUTH ROUTES (unchanged)
// ============================================================
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

// ============================================================
//  10. CHAT STREAM (unchanged)
// ============================================================
app.post('/api/chat/stream', auth, upload.array('files', 10), async (req, res) => {
    // ... (same as previous, keep it)
    // To save space, I'm not pasting the entire chat route again.
    // But you must include it from your original code.
    // For a complete file, copy from previous response.
});

// ============================================================
//  11. IMAGE GENERATION (unchanged)
// ============================================================
// ...

// ============================================================
//  12. PAYMENT (unchanged)
// ============================================================
// ...

// ============================================================
//  13. PAYSTACK WEBHOOK (unchanged)
// ============================================================
// ...

// ============================================================
//  14. START
// ============================================================
app.listen(PORT, () => console.log(`🚀 TechNovaphy AI Backend running on port ${PORT}`));
