// ============================================================
//  TECHNOVAPHY AI – COMPLETE BACKEND (FINAL)
//  - All features: auth, chat (truncated), gamification, referrals,
//    templates, sharing, image generation, payments (KES & NGN)
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
const crypto = require('crypto');

const app = express();

// ----- CORS -----
app.use(cors({
    origin: '*',
    methods: ['GET','POST','PUT','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization','Accept'],
    credentials: true,
    optionsSuccessStatus: 200
}));

// ----- Middleware -----
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// ----- Rate Limiter for auth -----
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    handler: (req, res) => {
        res.status(429).json({ error: 'Too many login attempts.' });
    }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ----- Environment Variables -----
const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'JWT_SECRET',
    'GROQ_API_KEY',
    'PAYSTACK_SECRET_KEY',
    'AGNES_API_KEY'
];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
    console.error('❌ Missing environment variables:', missing.join(', '));
    process.exit(1);
}

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const AGNES_API_KEY = process.env.AGNES_API_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://your-frontend-url.netlify.app';
const OWNER_EMAIL = process.env.OWNER_EMAIL || null;

// ----- Supabase Client -----
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
(async function initDb() {
    try {
        const { error } = await supabase.from('users').select('id').limit(1);
        if (error) {
            console.warn('⚠️ Supabase connection issue:', error.message);
        } else {
            console.log('✅ Database connected.');
        }
    } catch (e) {
        console.warn('⚠️ Could not connect to Supabase:', e.message);
    }
})();

// ============================================================
//  CONSTANTS & PRICING
// ============================================================

const TIER_PRICES_KES = {
    starter: 200,
    pro: 1700,
    enterprise: 17000,
    ultimate: 100000
};

const TIER_LIMITS = {
    free: 200,
    starter: 200,
    pro: 2500,
    enterprise: Infinity,
    ultimate: 1000000
};

const TIER_NAMES = {
    free: 'Free (5 hrs unlimited)',
    starter: 'Starter (Weekly)',
    pro: 'Pro (Monthly)',
    enterprise: 'Enterprise (Monthly)',
    ultimate: 'Ultimate (Monthly)'
};

const FREE_SESSION_HOURS = 5;
const FREE_LOCK_HOURS = 4;
const POINTS_PER_MESSAGE = 10;
const MAX_CONVERSATION_HISTORY = 12; // prevent 413 token limit

// ============================================================
//  BADGES
// ============================================================

const BADGES = {
    first_chat: {
        id: 'first_chat',
        name: 'First Chat',
        icon: '🌟',
        description: 'Had your first conversation',
        requirement: 1,
        requirement_type: 'messages'
    },
    chatty_5: {
        id: 'chatty_5',
        name: '5-Day Streak',
        icon: '🔥',
        description: 'Maintained a 5-day streak',
        requirement: 5,
        requirement_type: 'streak'
    },
    chatty_10: {
        id: 'chatty_10',
        name: '10-Day Streak',
        icon: '🔥🔥',
        description: 'Maintained a 10-day streak',
        requirement: 10,
        requirement_type: 'streak'
    },
    chatty_100: {
        id: 'chatty_100',
        name: 'Chatty',
        icon: '💬',
        description: 'Send 100 messages',
        requirement: 100,
        requirement_type: 'messages'
    },
    artist: {
        id: 'artist',
        name: 'Artist',
        icon: '🎨',
        description: 'Generate 10 images',
        requirement: 10,
        requirement_type: 'images'
    },
    influencer: {
        id: 'influencer',
        name: 'Influencer',
        icon: '👥',
        description: 'Refer 5 friends',
        requirement: 5,
        requirement_type: 'referrals'
    },
    pro_subscriber: {
        id: 'pro_subscriber',
        name: 'Premium',
        icon: '💎',
        description: 'Subscribe to Pro or higher',
        requirement: 1,
        requirement_type: 'subscription'
    }
};

// ============================================================
//  TEMPLATES
// ============================================================

const FREELANCER_TEMPLATES = [
    {
        id: 'job_proposal',
        name: 'Job Proposal',
        category: 'freelancer',
        description: 'Personalized proposal for freelance jobs',
        prompt: 'Based on this job description, write a professional proposal that highlights my skills and experience:\n\n{job_description}\n\nMy experience: {experience}'
    },
    {
        id: 'cover_letter',
        name: 'Cover Letter',
        category: 'freelancer',
        description: 'Professional cover letter generator',
        prompt: 'Write a compelling cover letter for this job:\n\n{job_description}\n\nMy background: {background}'
    },
    {
        id: 'rate_negotiation',
        name: 'Rate Negotiation Email',
        category: 'freelancer',
        description: 'Email to negotiate rates with clients',
        prompt: 'Write a professional email negotiating my rate for this project. Current offer: {current_rate}, My desired rate: {desired_rate}. Project: {project_details}'
    },
    {
        id: 'invoice_email',
        name: 'Invoice Email',
        category: 'freelancer',
        description: 'Professional invoice reminder email',
        prompt: 'Write a professional invoice reminder email for a client who owes {amount} KES for {project_name}. Invoice date: {invoice_date}'
    }
];

const BUSINESS_TEMPLATES = [
    {
        id: 'business_plan',
        name: 'Business Plan Outline',
        category: 'business',
        description: 'Structured business plan template',
        prompt: 'Create a business plan outline for: {business_description}. Target market: {target_market}. Budget: {budget}'
    },
    {
        id: 'marketing_email',
        name: 'Marketing Email',
        category: 'business',
        description: 'Email marketing template for campaigns',
        prompt: 'Write a marketing email for {product_name}. Key benefits: {benefits}. Target audience: {audience}'
    },
    {
        id: 'social_media_post',
        name: 'Social Media Post',
        category: 'business',
        description: 'Engaging social media content',
        prompt: 'Write 5 engaging social media posts for {business_name} to promote {offer}. Make them engaging and use emojis.'
    },
    {
        id: 'invoice_template',
        name: 'Invoice Generator',
        category: 'business',
        description: 'Professional invoice template',
        prompt: 'Generate a professional invoice for: Client: {client_name}, Amount: {amount} KES, Items: {items}, Due date: {due_date}'
    }
];

// ============================================================
//  DAILY CHALLENGES
// ============================================================

const DAILY_CHALLENGES_POOL = [
    { id: 'message_3', title: 'Send 3 Messages', description: 'Ask me 3 different questions', points: 5, requirement_type: 'messages', requirement_count: 3 },
    { id: 'image_generate', title: 'Generate an Image', description: 'Try image generation feature', points: 5, requirement_type: 'image_generation', requirement_count: 1 },
    { id: 'file_upload', title: 'Upload & Analyze', description: 'Upload a file and ask me questions about it', points: 10, requirement_type: 'file_upload', requirement_count: 1 },
    { id: 'share_response', title: 'Share a Response', description: 'Share one of my responses with friends', points: 10, requirement_type: 'share', requirement_count: 1 },
    { id: 'refer_friend', title: 'Refer a Friend', description: 'Invite someone to TechNovaphy AI', points: 20, requirement_type: 'referral', requirement_count: 1 }
];

// ============================================================
//  EXCHANGE RATES (cached)
// ============================================================

let exchangeRates = { KES: 1 };
let ratesLastFetched = 0;
const RATES_CACHE_TTL = 60 * 60 * 1000;

async function fetchExchangeRates() {
    const now = Date.now();
    if (now - ratesLastFetched < RATES_CACHE_TTL) return exchangeRates;
    try {
        const response = await fetch('https://api.exchangerate-api.com/v4/latest/KES');
        if (!response.ok) throw new Error('Exchange rate API error');
        const data = await response.json();
        exchangeRates = data.rates;
        exchangeRates.KES = 1;
        ratesLastFetched = now;
        console.log('✅ Exchange rates updated');
    } catch (err) {
        console.warn('⚠️ Failed to fetch exchange rates, using fallback');
        exchangeRates = {
            KES: 1,
            NGN: 12.5,
        
            
        };
    }
    return exchangeRates;
}

// ============================================================
//  USER HELPERS
// ============================================================

async function findUser(email) {
    const { data, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
    if (error) throw new Error('DB: ' + error.message);
    return data;
}

async function findUserById(id) {
    const { data, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error('DB: ' + error.message);
    return data;
}

async function findUserByReferralCode(code) {
    const { data, error } = await supabase.from('users').select('*').eq('referral_code', code).maybeSingle();
    if (error) throw new Error('DB: ' + error.message);
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
                monthly_reset_date: nextMonth.toISOString().split('T')[0]
            })
            .eq('id', user.id);
        user.usage_count = 0;
        user.monthly_reset_date = nextMonth.toISOString().split('T')[0];
    }
    return user;
}

async function checkFreeSession(user) {
    if (user.tier !== 'free') return user;
    const now = new Date();
    const sessionStart = new Date(user.free_session_start || now);
    const elapsedHours = (now - sessionStart) / (1000 * 60 * 60);
    if (elapsedHours < FREE_SESSION_HOURS) {
        return user;
    } else {
        const lockEnd = new Date(sessionStart.getTime() + (FREE_SESSION_HOURS + FREE_LOCK_HOURS) * 60 * 60 * 1000);
        if (now < lockEnd) {
            const minutesLeft = Math.ceil((lockEnd - now) / 60000);
            const err = new Error(`Free session ended. Try again in ${minutesLeft} minutes.`);
            err.minutesLeft = minutesLeft;
            throw err;
        } else {
            const newSessionStart = now.toISOString();
            await supabase
                .from('users')
                .update({ free_session_start: newSessionStart })
                .eq('id', user.id);
            user.free_session_start = newSessionStart;
            return user;
        }
    }
}

function getLimit(tier) { return TIER_LIMITS[tier] || 200; }

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

// ============================================================
//  STREAK & GAMIFICATION HELPERS
// ============================================================

async function updateStreakIfNeeded(user) {
    const today = new Date().toISOString().split('T')[0];
    const lastChat = user.last_chat_date ? new Date(user.last_chat_date).toISOString().split('T')[0] : null;
    if (today !== lastChat) {
        const daysSinceLast = lastChat ? Math.floor((new Date(today) - new Date(lastChat)) / (1000*60*60*24)) : 1;
        let newStreak = daysSinceLast === 1 ? (user.streak_count || 0) + 1 : 1;
        await supabase.from('users').update({
            streak_count: newStreak,
            last_chat_date: new Date().toISOString(),
            best_streak: Math.max(user.best_streak || 0, newStreak)
        }).eq('id', user.id);
        user.streak_count = newStreak;
        user.last_chat_date = new Date().toISOString();
    }
    return user;
}

async function addPoints(userId, points) {
    const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
    if (!user) return null;
    const newBalance = (user.points_balance || 0) + points;
    await supabase.from('users').update({
        points_balance: newBalance,
        points_earned_total: (user.points_earned_total || 0) + points
    }).eq('id', userId);
    return newBalance;
}

async function checkAndUnlockBadges(userId, user) {
    const unlocked = [];
    for (const [badgeKey, badge] of Object.entries(BADGES)) {
        const { data: existing } = await supabase
            .from('user_badges')
            .select('*')
            .eq('user_id', userId)
            .eq('badge_id', badge.id)
            .maybeSingle();
        if (existing) continue;
        let shouldUnlock = false;
        if (badge.requirement_type === 'messages' && user.usage_count >= badge.requirement) shouldUnlock = true;
        else if (badge.requirement_type === 'streak' && (user.streak_count || 0) >= badge.requirement) shouldUnlock = true;
        else if (badge.requirement_type === 'images' && (user.images_generated || 0) >= badge.requirement) shouldUnlock = true;
        else if (badge.requirement_type === 'referrals' && (user.referrals_count || 0) >= badge.requirement) shouldUnlock = true;
        else if (badge.requirement_type === 'subscription' && (user.tier !== 'free' && user.tier !== 'starter')) shouldUnlock = true;
        if (shouldUnlock) {
            await supabase.from('user_badges').insert({
                user_id: userId,
                badge_id: badge.id,
                unlocked_at: new Date().toISOString()
            });
            unlocked.push(badge);
        }
    }
    return unlocked;
}

// ============================================================
//  FILE UPLOAD
// ============================================================

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
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter
});

async function extractFileContent(file) {
    const mimeType = file.mimetype;
    const buffer = file.buffer;
    if (mimeType === 'application/pdf') {
        try {
            const data = await pdfParse(buffer);
            return data.text;
        } catch(e) {
            return `[PDF could not be read: ${e.message}]`;
        }
    } else if (mimeType === 'text/plain' || mimeType === 'text/csv') {
        return buffer.toString('utf-8');
    } else if (mimeType.startsWith('image/')) {
        return `[Image: ${file.originalname}]`;
    } else {
        try { return buffer.toString('utf-8'); } catch(e) { return `[File: ${file.originalname}]`; }
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
//  AUTH MIDDLEWARE
// ============================================================

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
    } catch(e) {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
};

// ============================================================
//  PER-USER RATE LIMITING
// ============================================================

const userRateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 10;

setInterval(() => {
    const now = Date.now();
    for (const [userId, timestamps] of userRateLimit) {
        const filtered = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
        if (filtered.length === 0) {
            userRateLimit.delete(userId);
        } else {
            userRateLimit.set(userId, filtered);
        }
    }
}, 60 * 1000);

function checkRateLimit(userId) {
    const now = Date.now();
    if (!userRateLimit.has(userId)) {
        userRateLimit.set(userId, [now]);
        return true;
    }
    const timestamps = userRateLimit.get(userId);
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (recent.length >= RATE_LIMIT_MAX) {
        return false;
    }
    recent.push(now);
    userRateLimit.set(userId, recent);
    return true;
}

// ============================================================
//  PUBLIC & AUTH ROUTES
// ============================================================

app.get('/', (req, res) => res.send('TechNovaphy AI Backend running'));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/ping', (req, res) => res.json({ status: 'ok', message: 'Backend is reachable!' }));

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, ageConfirmed, country } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        if (!ageConfirmed) return res.status(400).json({ error: 'You must be 18 or older' });

        const existing = await findUser(email);
        if (existing) return res.status(400).json({ error: 'Email already exists' });

        const hashed = await bcrypt.hash(password, 10);
        const now = new Date();
        const nextMonth = new Date(now);
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        const referralCode = `${email.split('@')[0]}-${crypto.randomBytes(4).toString('hex')}`.toUpperCase();

        const { data, error } = await supabase
            .from('users')
            .insert({
                email,
                password_hash: hashed,
                tier: 'free',
                usage_count: 0,
                monthly_reset_date: nextMonth.toISOString().split('T')[0],
                verified: true,
                free_session_start: now.toISOString(),
                memory: '',
                role: 'user',
                country: country || 'KE',
                streak_count: 0,
                last_chat_date: now.toISOString(),
                best_streak: 0,
                points_balance: 0,
                points_earned_total: 0,
                points_spent_total: 0,
                referral_code: referralCode,
                referred_by: null,
                referrals_count: 0,
                referral_credit: 0,
                images_generated: 0
            })
            .select()
            .single();

        if (error) throw new Error('DB insert: ' + error.message);
        await supabase.from('conversations').insert({ user_id: data.id, messages: [] });
        await supabase.from('user_badges').insert({
            user_id: data.id,
            badge_id: 'first_chat',
            unlocked_at: now.toISOString()
        });

        res.status(201).json({ message: 'User created', userId: data.id, referral_code: referralCode });
    } catch(err) {
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
    } catch(err) {
        console.error('Login error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/user/profile', auth, async (req, res) => {
    try {
        let user = req.user;
        user = await resetMonthlyUsageIfNeeded(user);
        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL) || user.role === 'owner';

        let sessionRemaining = null, lockRemaining = null;
        if (user.tier === 'free') {
            const now = new Date();
            const sessionStart = new Date(user.free_session_start || now);
            const elapsedHours = (now - sessionStart) / (1000 * 60 * 60);
            if (elapsedHours < FREE_SESSION_HOURS) {
                const remainingMs = (sessionStart.getTime() + FREE_SESSION_HOURS * 60 * 60 * 1000) - now.getTime();
                sessionRemaining = Math.max(0, Math.ceil(remainingMs / 60000));
            } else {
                const lockEnd = new Date(sessionStart.getTime() + (FREE_SESSION_HOURS + FREE_LOCK_HOURS) * 60 * 60 * 1000);
                if (now < lockEnd) {
                    const remainingMs = lockEnd - now;
                    lockRemaining = Math.max(0, Math.ceil(remainingMs / 60000));
                } else {
                    lockRemaining = 0;
                }
            }
        }

        const limit = getLimit(user.tier);

        res.json({
            email: user.email,
            tier: user.tier,
            tier_name: TIER_NAMES[user.tier] || 'Free',
            usage_count: user.usage_count,
            limit: limit,
            monthly_reset_date: user.monthly_reset_date,
            verified: true,
            memory: user.memory || '',
            role: user.role || 'user',
            is_owner: isOwner,
            free_session_start: user.free_session_start,
            session_remaining_minutes: sessionRemaining,
            lock_remaining_minutes: lockRemaining,
            country: user.country || 'KE',
            streak_count: user.streak_count || 0,
            best_streak: user.best_streak || 0,
            points_balance: user.points_balance || 0,
            referral_code: user.referral_code,
            referrals_count: user.referrals_count || 0,
            referral_credit: user.referral_credit || 0
        });
    } catch(err) {
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
    } catch(err) {
        console.error('Update memory error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/users', auth, async (req, res) => {
    try {
        const user = req.user;
        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL) || user.role === 'owner';
        if (!isOwner) return res.status(403).json({ error: 'Admin access required.' });
        const { data, error } = await supabase
            .from('users')
            .select('id, email, tier, role, usage_count, created_at, free_session_start, country, streak_count, points_balance')
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ users: data });
    } catch(err) {
        console.error('Admin users error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GAMIFICATION ENDPOINTS
// ============================================================

app.get('/api/user/streak', auth, async (req, res) => {
    try {
        const user = req.user;
        res.json({
            current_streak: user.streak_count || 0,
            best_streak: user.best_streak || 0,
            message: (user.streak_count || 0) > 0 ? `🔥 ${user.streak_count}-day streak!` : 'Start a streak!'
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/user/points', auth, async (req, res) => {
    try {
        const user = req.user;
        res.json({
            current_points: user.points_balance || 0,
            earned_total: user.points_earned_total || 0,
            spent_total: user.points_spent_total || 0,
            redemption_options: [
                { id: 1, name: '5 free messages', cost: 50, points: 5 },
                { id: 2, name: '10% off Pro tier', cost: 100, points: 10 },
                { id: 3, name: '50 bonus messages', cost: 150, points: 15 }
            ]
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/user/badges', auth, async (req, res) => {
    try {
        const user = req.user;
        const { data: unlockedData } = await supabase
            .from('user_badges')
            .select('badge_id')
            .eq('user_id', user.id);
        const unlockedIds = unlockedData ? unlockedData.map(b => b.badge_id) : [];
        const unlocked = [];
        const progress = [];
        for (const [badgeKey, badge] of Object.entries(BADGES)) {
            if (unlockedIds.includes(badge.id)) {
                unlocked.push({ id: badge.id, name: badge.name, icon: badge.icon });
            } else {
                let currentProgress = 0;
                if (badge.requirement_type === 'messages') currentProgress = user.usage_count || 0;
                else if (badge.requirement_type === 'streak') currentProgress = user.streak_count || 0;
                else if (badge.requirement_type === 'images') currentProgress = user.images_generated || 0;
                else if (badge.requirement_type === 'referrals') currentProgress = user.referrals_count || 0;
                progress.push({
                    id: badge.id,
                    name: badge.name,
                    icon: badge.icon,
                    progress: currentProgress,
                    requirement: badge.requirement,
                    requirement_type: badge.requirement_type
                });
            }
        }
        res.json({ unlocked, progress });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/challenges/today', auth, async (req, res) => {
    try {
        const user = req.user;
        const today = new Date().toISOString().split('T')[0];
        const { data: existingChallenges } = await supabase
            .from('daily_challenges')
            .select('*')
            .eq('user_id', user.id)
            .eq('date', today);
        let challenges = existingChallenges || [];
        if (challenges.length === 0) {
            const shuffled = DAILY_CHALLENGES_POOL.sort(() => 0.5 - Math.random()).slice(0, 3);
            for (const challenge of shuffled) {
                await supabase.from('daily_challenges').insert({
                    user_id: user.id,
                    challenge_id: challenge.id,
                    title: challenge.title,
                    description: challenge.description,
                    points_reward: challenge.points,
                    completed: false,
                    date: today
                });
            }
            challenges = shuffled.map(c => ({ ...c, user_id: user.id, date: today, completed: false }));
        }
        const totalPoints = challenges.reduce((sum, c) => sum + (c.points_reward || c.points || 0), 0);
        res.json({
            challenges: challenges.map(c => ({
                id: c.challenge_id || c.id,
                title: c.title,
                description: c.description,
                points: c.points_reward || c.points,
                completed: c.completed
            })),
            total_points_available: totalPoints
        });
    } catch(err) {
        console.error('Challenges error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/challenges/complete', auth, async (req, res) => {
    try {
        const user = req.user;
        const { challenge_id } = req.body;
        const today = new Date().toISOString().split('T')[0];
        const { data: challenge } = await supabase
            .from('daily_challenges')
            .select('*')
            .eq('user_id', user.id)
            .eq('challenge_id', challenge_id)
            .eq('date', today)
            .single();
        if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
        if (challenge.completed) return res.status(400).json({ error: 'Already completed' });
        await supabase.from('daily_challenges').update({ completed: true }).eq('id', challenge.id);
        const points = challenge.points_reward;
        await addPoints(user.id, points);
        res.json({ message: `✅ Challenge completed! +${points} points`, points });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/leaderboard/:country', async (req, res) => {
    try {
        const { country } = req.params;
        const validCountries = ['KE', 'NG'];
        if (!validCountries.includes(country)) {
            return res.status(400).json({ error: 'Invalid country. Supported: KE, NG' });
        }
        const { data } = await supabase
            .from('users')
            .select('id, email, points_balance, usage_count, streak_count')
            .eq('country', country)
            .order('points_balance', { ascending: false })
            .limit(50);
        const leaderboard = (data || []).map((user, idx) => ({
            rank: idx + 1,
            name: user.email.split('@')[0],
            points: user.points_balance || 0,
            messages: user.usage_count || 0,
            streak: user.streak_count || 0
        }));
        res.json({ leaderboard, country });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  REFERRAL ENDPOINTS
// ============================================================

app.get('/api/user/referral', auth, async (req, res) => {
    try {
        const user = req.user;
        res.json({
            referral_code: user.referral_code,
            referral_link: `${FRONTEND_URL}?ref=${user.referral_code}`,
            whatsapp_link: `https://wa.me/?text=Join%20TechNovaphy%20AI%21%20Use%20my%20code%20${user.referral_code}%20for%2020%25%20off`,
            referrals_count: user.referrals_count || 0,
            referral_credit: user.referral_credit || 0,
            can_redeem: (user.referral_credit || 0) >= 500
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/referral/redeem', auth, async (req, res) => {
    try {
        const user = req.user;
        const credit = user.referral_credit || 0;
        if (credit < 500) {
            return res.status(400).json({ error: 'Insufficient referral credit (need 500 KES)' });
        }
        await supabase.from('users').update({
            referral_credit: 0,
            points_balance: (user.points_balance || 0) + Math.floor(credit / 10)
        }).eq('id', user.id);
        res.json({ message: `✅ ${credit} KES redeemed!`, points_added: Math.floor(credit / 10) });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/referral/apply', async (req, res) => {
    try {
        const { referral_code, email } = req.body;
        if (!referral_code || !email) {
            return res.status(400).json({ error: 'Referral code and email required' });
        }
        const referrer = await findUserByReferralCode(referral_code);
        if (!referrer) return res.status(404).json({ error: 'Invalid referral code' });
        const referee = await findUser(email);
        if (!referee) return res.status(404).json({ error: 'User not found' });
        await supabase.from('users').update({
            referral_credit: (referrer.referral_credit || 0) + 200,
            referrals_count: (referrer.referrals_count || 0) + 1
        }).eq('id', referrer.id);
        await supabase.from('users').update({
            points_balance: (referee.points_balance || 0) + 50
        }).eq('id', referee.id);
        res.json({ message: '✅ Referral applied! Both users get bonuses' });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  TEMPLATES ENDPOINTS
// ============================================================

app.get('/api/templates', auth, async (req, res) => {
    try {
        const { category } = req.query;
        let templates = [];
        if (category === 'freelancer') templates = FREELANCER_TEMPLATES;
        else if (category === 'business') templates = BUSINESS_TEMPLATES;
        else templates = [...FREELANCER_TEMPLATES, ...BUSINESS_TEMPLATES];
        res.json({ templates });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/templates/apply', auth, upload.array('files', 1), async (req, res) => {
    try {
        const { template_id, data } = req.body;
        const user = req.user;
        const allTemplates = [...FREELANCER_TEMPLATES, ...BUSINESS_TEMPLATES];
        const template = allTemplates.find(t => t.id === template_id);
        if (!template) return res.status(404).json({ error: 'Template not found' });
        const templateData = JSON.parse(data);
        let prompt = template.prompt;
        for (const [key, value] of Object.entries(templateData)) {
            prompt = prompt.replace(`{${key}}`, value);
        }
        const groqMessages = [{ role: 'user', content: prompt }];
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: groqMessages,
                temperature: 0.7,
                max_tokens: 1024
            })
        });
        const result = await response.json();
        const generatedContent = result.choices[0]?.message?.content || '';
        res.json({ template_name: template.name, generated: generatedContent, shareable: true });
    } catch(err) {
        console.error('Template error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  SHARE ENDPOINT
// ============================================================

app.post('/api/share/create', auth, async (req, res) => {
    try {
        const { message } = req.body;
        const shareId = crypto.randomBytes(8).toString('hex');
        await supabase.from('shared_responses').insert({
            share_id: shareId,
            user_id: req.user.id,
            response: message,
            created_at: new Date().toISOString()
        });
        const shareLink = `${FRONTEND_URL}/share/${shareId}`;
        const whatsappText = `Check this response from TechNovaphy AI: ${shareLink}`;
        res.json({
            share_id: shareId,
            share_link: shareLink,
            whatsapp_link: `https://wa.me/?text=${encodeURIComponent(whatsappText)}`,
            twitter_link: `https://twitter.com/intent/tweet?text=Check%20this%20response%20from%20TechNovaphy%20AI&url=${encodeURIComponent(shareLink)}`
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/share/:shareId', async (req, res) => {
    try {
        const { shareId } = req.params;
        const { data: share } = await supabase
            .from('shared_responses')
            .select('*')
            .eq('share_id', shareId)
            .single();
        if (!share) return res.status(404).json({ error: 'Share not found' });
        res.json({
            response: share.response,
            created_at: share.created_at,
            created_by: share.user_id
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  CHAT STREAM – WITH TRUNCATION (FIXED)
// ============================================================

app.post('/api/chat/stream', auth, upload.array('files', 10), async (req, res) => {
    try {
        let user = req.user;
        user = await resetMonthlyUsageIfNeeded(user);
        user = await updateStreakIfNeeded(user);

        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL) || user.role === 'owner';
        if (!isOwner) {
            if (!checkRateLimit(user.id)) {
                return res.status(429).json({ error: 'Too many chat requests. Please wait a moment.' });
            }
            if (user.tier === 'free') {
                try { user = await checkFreeSession(user); }
                catch(lockError) {
                    return res.status(429).json({
                        error: lockError.message,
                        lock_remaining_minutes: lockError.minutesLeft || null
                    });
                }
            }
            const monthlyLimit = getLimit(user.tier);
            if (user.usage_count >= monthlyLimit) {
                return res.status(403).json({
                    error: `You've reached your monthly limit of ${monthlyLimit} messages. Upgrade to continue.`,
                    tier: user.tier,
                    limit: monthlyLimit,
                    used: user.usage_count
                });
            }
        }

        // ---- Build conversation ----
        let conversation = await getConversation(user.id);
        let newMessages;
        try { newMessages = JSON.parse(req.body.messages); }
        catch(e) { return res.status(400).json({ error: 'Invalid messages format' }); }
        conversation = conversation.concat(newMessages);

        // ---- TRUNCATE CONVERSATION to last MAX_CONVERSATION_HISTORY messages ----
        if (conversation.length > MAX_CONVERSATION_HISTORY) {
            conversation = conversation.slice(-MAX_CONVERSATION_HISTORY);
            console.log(`📝 Truncated conversation to last ${conversation.length} messages`);
        }

        // ---- Process files ----
        const files = req.files || [];
        const hasImage = files.some(f => f.mimetype.startsWith('image/'));
        let userContent = conversation[conversation.length - 1]?.content || '';
        let fileTextContent = '';
        const imageContents = [];

        for (const file of files) {
            if (file.mimetype.startsWith('image/')) {
                const base64 = file.buffer.toString('base64');
                const dataUrl = `data:${file.mimetype};base64,${base64}`;
                imageContents.push({ type: 'image_url', image_url: { url: dataUrl } });
            } else {
                const text = await extractFileContent(file);
                fileTextContent += `\n\n--- File: ${file.originalname} ---\n${text}\n--- End of ${file.originalname} ---`;
            }
        }

        let finalUserMessage;
        if (hasImage) {
            const textPart = userContent + (fileTextContent ? `\n\n${fileTextContent}` : '');
            finalUserMessage = {
                role: 'user',
                content: [
                    { type: 'text', text: textPart },
                    ...imageContents
                ]
            };
        } else {
            const fullText = userContent + (fileTextContent ? `\n\n${fileTextContent}` : '');
            finalUserMessage = { role: 'user', content: fullText };
        }

        conversation.pop();
        conversation.push(finalUserMessage);

        // ---- Update usage & points ----
        if (!isOwner) {
            const newMonthlyUsage = (user.usage_count || 0) + 1;
            await supabase
                .from('users')
                .update({ usage_count: newMonthlyUsage })
                .eq('id', user.id);
            await addPoints(user.id, POINTS_PER_MESSAGE);
        }

        // ---- Language & system prompt ----
        const language = req.body.language || 'auto';
        let languageInstruction = '';
        if (language !== 'auto') {
            languageInstruction = `\n\n**Important**: Respond exclusively in **${language}**.\n`;
        } else {
            languageInstruction = `\n\n**Important**: Detect the user's language and respond in the same language.\n`;
        }

        const memoryPrompt = user.memory ? `\n\nUser context: ${user.memory}` : '';
        const systemPrompt = `You are TechNovaphy AI – a warm, thoughtful, and highly capable African assistant.

Your goal is not just to answer questions, but to **understand, guide, and empower** the user.
You think step‑by‑step, offer structure, and always provide actionable value.

Always:
- Start with a warm, human greeting (e.g., "That's a great question!", "I can see why you'd ask that.").
- Break down problems into clear, logical steps.
- Offer multiple solutions when possible, and explain the trade‑offs.
- Use structure: headings, bullet points, tables, code blocks.
- Admit when you're unsure, but always offer a thoughtful suggestion.
- End with a thoughtful question or next step (e.g., "What would you like to explore next?").
- Be professional, but approachable – like a trusted mentor.

You understand African contexts, cultures, and challenges.
You speak with kindness, patience, and a touch of humour.
You are proud of African innovation and technology.

You excel at IT, web development, cloud architecture, business strategy, freelancing, and general knowledge.
${memoryPrompt}
${languageInstruction}`;

        const groqMessages = [{ role: 'system', content: systemPrompt }, ...conversation];
        const model = hasImage ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'llama-3.3-70b-versatile';

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                messages: groqMessages,
                temperature: 0.7,
                top_p: 0.9,
                stream: true
            })
        });

        if (!groqResponse.ok) {
            const errorText = await groqResponse.text();
            let errorMessage = `Groq API error ${groqResponse.status}`;
            try {
                const errorJson = JSON.parse(errorText);
                if (errorJson.error && errorJson.error.message) {
                    errorMessage = errorJson.error.message;
                }
            } catch(e) {}
            if (groqResponse.status === 413) {
                errorMessage = 'Your conversation is too long. Please start a new chat or shorten your message. (Token limit exceeded)';
            }
            throw new Error(errorMessage);
        }

        const reader = groqResponse.body.getReader();
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
                            res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
                        }
                    } catch(e) {}
                }
            }
        }

        conversation.push({ role: 'assistant', content: fullContent });
        await saveConversation(user.id, conversation);

        // ---- Check badges ----
        const unlockedBadges = await checkAndUnlockBadges(user.id, user);

        const suggestions = generateSuggestions(fullContent);
        const upgrade_prompt = user.tier === 'free' && user.usage_count >= 50 ? {
            show: true,
            message: "You're loving this! Upgrade for unlimited messages"
        } : null;

        res.write(`data: ${JSON.stringify({
            type: 'done',
            text: fullContent,
            suggestions,
            points_earned: POINTS_PER_MESSAGE,
            badges_unlocked: unlockedBadges,
            upgrade_prompt
        })}\n\n`);
        res.end();

    } catch(err) {
        console.error('Chat stream error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message || 'Something went wrong.' });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
            res.end();
        }
    }
});

// ============================================================
//  IMAGE GENERATION
// ============================================================

app.post('/api/generate-image', auth, async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

        let imageUrl = null;
        let usedFallback = false;

        if (AGNES_API_KEY) {
            const modelsToTry = [
                process.env.AGNES_IMAGE_MODEL,
                'Agnes-Image-2.0-Flash',
                'Agnes-Image-2.0',
                'Agnes-Image-2.1-Flash',
                'Agnes-Image-2.1'
            ].filter(Boolean);

            for (const model of modelsToTry) {
                try {
                    console.log(`🎨 Trying Agnes model: ${model}`);
                    const response = await fetch('https://apihub.agnes-ai.com/v1/images/generations', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${AGNES_API_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: model,
                            prompt: prompt,
                            n: 1,
                            size: '1024x1024'
                        })
                    });

                    if (response.ok) {
                        const data = await response.json();
                        const url = data?.data?.[0]?.url;
                        if (url) {
                            imageUrl = url;
                            console.log(`✅ Image generated with Agnes`);
                            const user = req.user;
                            await supabase.from('users').update({
                                images_generated: (user.images_generated || 0) + 1
                            }).eq('id', user.id);
                            break;
                        }
                    }
                } catch (err) {
                    console.warn(`⚠️ Error with Agnes model ${model}:`, err.message);
                }
            }
        }

        if (!imageUrl) {
            console.log('🔄 Falling back to Pollinations.ai');
            usedFallback = true;
            imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
        }

        if (!imageUrl) throw new Error('All image generation methods failed.');
        res.json({ url: imageUrl, fallback: usedFallback });
    } catch(err) {
        console.error('❌ Image gen error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  PAYMENT – SUPPORTS NGN AND KES
// ============================================================

app.post('/api/create-checkout', auth, async (req, res) => {
    try {
        const { idempotencyKey, tier, currency } = req.body;
        const user = req.user;

        console.log(`📦 Checkout request: tier=${tier}, currency=${currency}`);

        if (!tier || !['starter', 'pro', 'enterprise', 'ultimate'].includes(tier)) {
            return res.status(400).json({ error: 'Invalid tier selected.' });
        }

        // ---- Determine final currency ----
        let finalCurrency = (currency || '').toUpperCase();
        if (!finalCurrency) {
            const userCountry = user.country || 'KE';
            finalCurrency = userCountry === 'NG' ? 'NGN' : 'KES';
        }

        // ---- Supported African currencies (including NGN and KES) ----
        const supportedCurrencies = ['KES', 'NGN', 'GHS', 'ZAR', 'EGP', 'RWF', 'TZS', 'UGX', 'XOF', 'XAF'];
        if (!supportedCurrencies.includes(finalCurrency)) {
            console.warn(`⚠️ Unsupported currency ${finalCurrency}, defaulting to KES`);
            finalCurrency = 'KES';
        }

        // ---- Amount conversion ----
        let amount = TIER_PRICES_KES[tier]; // base in KES

        if (finalCurrency !== 'KES') {
            const rates = await fetchExchangeRates();
            const rate = rates[finalCurrency];
            if (rate) {
                const converted = amount * rate;
                const withCents = ['USD','EUR','GBP','ZAR','EGP'];
                amount = withCents.includes(finalCurrency) ? Math.round(converted * 100) : Math.round(converted);
                console.log(`💱 ${TIER_PRICES_KES[tier]} KES → ${amount} ${finalCurrency}`);
            } else {
                console.warn(`⚠️ Rate missing for ${finalCurrency}, defaulting to KES`);
                finalCurrency = 'KES';
                amount = TIER_PRICES_KES[tier];
            }
        } else {
            amount = TIER_PRICES_KES[tier];
        }

        // ---- Check duplicate ----
        const { data: existing } = await supabase
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

        // ---- Paystack channels ----
        let channels = ['card', 'bank_transfer'];
        if (finalCurrency === 'KES') {
            channels.push('mpesa');
        } else if (finalCurrency === 'NGN') {
            channels.push('bank', 'ussd');
        }

        // ---- Initialize Paystack ----
        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: user.email,
                amount: amount,
                currency: finalCurrency,
                channels: channels,
                metadata: {
                    idempotencyKey,
                    tier,
                    userId: user.id
                },
                callback_url: `${FRONTEND_URL}/?success=true`
            })
        });

        const data = await response.json();
        if (!data.status) {
            console.error('❌ Paystack error:', data);
            return res.status(500).json({ error: data.message || 'Paystack initialization failed' });
        }

        // ---- Record payment ----
        await supabase.from('payments').insert({
            user_id: user.id,
            transaction_id: idempotencyKey,
            amount: amount,
            currency: finalCurrency,
            status: 'pending',
            tier
        });

        console.log(`✅ Payment initialized: ${amount} ${finalCurrency} for ${tier}`);
        res.json({ url: data.data.authorization_url });
    } catch(err) {
        console.error('❌ Checkout error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  PAYSTACK WEBHOOK
// ============================================================

app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const payload = req.body;
        const event = payload.event;
        const data = payload.data;

        if (event === 'charge.success') {
            const metadata = data.metadata || {};
            const userId = metadata.userId;
            const tier = metadata.tier || 'pro';
            const idempotencyKey = metadata.idempotencyKey;

            if (userId) {
                await supabase.from('payments').update({ status: 'completed' }).eq('transaction_id', idempotencyKey);
                await supabase.from('users').update({ tier: tier, usage_count: 0 }).eq('id', userId);
                console.log(`✅ User ${userId} upgraded to ${tier}`);
            }
        }
        res.sendStatus(200);
    } catch(err) {
        console.error('Webhook error:', err);
        res.sendStatus(500);
    }
});

// ============================================================
//  START SERVER
// ============================================================

app.listen(PORT, () => console.log(`🚀 TechNovaphy AI Backend running on port ${PORT}`));
