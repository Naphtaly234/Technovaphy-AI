
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

/app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: true,   
    optionsSuccessStatus: 200
}));

// ----- Environment Variables (declared early; needed by webhook route below) -----
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

// ----- Optional: OpenRouter (used for paid-tier chat quality upgrade) -----
// Not in the `required` list above — the app must still boot fine if this
// isn't set (e.g. local dev, or before you've added credits).
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || null;
const OPENROUTER_ENABLED = Boolean(OPENROUTER_API_KEY);
if (!OPENROUTER_ENABLED) {
    console.warn('⚠️ OPENROUTER_API_KEY not set — paid tiers will use Groq only.');
}

// ----- Optional: Redis (used for cross-instance rate limiting) -----
// Falls back to in-memory rate limiting if not set. In-memory works fine
// for a single server instance; Redis matters once you run more than one.
const REDIS_URL = process.env.REDIS_URL || null;

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
//  PAYSTACK WEBHOOK — MUST BE REGISTERED BEFORE express.json()
// ============================================================
// This route needs the RAW request body to verify Paystack's HMAC
// signature. If express.json() runs first (as a global app.use),
// it consumes the stream and there's nothing raw left to verify.
// That's why this is registered here, before the global JSON
// parser below, using its own express.raw() middleware.

app.post(
    '/api/webhooks/paystack',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        try {
            const signature = req.headers['x-paystack-signature'];
            if (!signature) {
                console.warn('⚠️ Webhook rejected: no signature header');
                return res.sendStatus(401);
            }

            const expectedHash = crypto
                .createHmac('sha512', PAYSTACK_SECRET_KEY)
                .update(req.body) // raw Buffer — required for HMAC to match
                .digest('hex');

            if (expectedHash !== signature) {
                console.warn('⚠️ Webhook rejected: signature mismatch');
                return res.sendStatus(401);
            }

            const payload = JSON.parse(req.body.toString('utf8'));
            const event = payload.event;
            const data = payload.data;

            if (event === 'charge.success') {
                const metadata = data.metadata || {};
                const userId = metadata.userId;
                const tier = metadata.tier || 'pro';
                const idempotencyKey = metadata.idempotencyKey;

                const { data: paymentRecord } = await supabase
                    .from('payments')
                    .select('*')
                    .eq('transaction_id', idempotencyKey)
                    .maybeSingle();

                if (!paymentRecord) {
                    console.warn(`⚠️ Webhook: no matching payment record for ${idempotencyKey}`);
                    return res.sendStatus(200);
                }

                if (paymentRecord.status === 'completed') {
                    return res.sendStatus(200); // already processed; Paystack retries webhooks
                }

                if (data.amount !== paymentRecord.amount || data.currency !== paymentRecord.currency) {
                    console.error(
                        `❌ Webhook amount mismatch for ${idempotencyKey}: ` +
                        `expected ${paymentRecord.amount} ${paymentRecord.currency}, got ${data.amount} ${data.currency}`
                    );
                    return res.sendStatus(200);
                }

                if (userId) {
                    await supabase.from('payments').update({ status: 'completed' }).eq('transaction_id', idempotencyKey);
                    await supabase.from('users').update({ tier: tier, usage_count: 0 }).eq('id', userId);
                    console.log(`✅ User ${userId} upgraded to ${tier}`);
                }
            }
            res.sendStatus(200);
        } catch (err) {
            console.error('Webhook error:', err);
            res.sendStatus(500);
        }
    }
);

// ----- Global body parsers (registered AFTER the webhook route) -----
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
            USD: 0.0077,
            EUR: 0.0070,
            GBP: 0.0061,
            NGN: 12.5,
            GHS: 0.098,
            ZAR: 0.14,
            EGP: 0.24,
            RWF: 10.2,
            TZS: 20.5,
            UGX: 30.0
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
        const daysSinceLast = lastChat ? Math.floor((new Date(today) - new Date(lastChat)) / (1000 * 60 * 60 * 24)) : 1;
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

// ----- PATCHED: batched badge lookup (was 7 separate queries per message) -----
async function checkAndUnlockBadges(userId, user) {
    const unlocked = [];

    const { data: existingBadges } = await supabase
        .from('user_badges')
        .select('badge_id')
        .eq('user_id', userId);
    const unlockedSet = new Set((existingBadges || []).map(b => b.badge_id));

    const toInsert = [];
    for (const badge of Object.values(BADGES)) {
        if (unlockedSet.has(badge.id)) continue;

        let shouldUnlock = false;
        if (badge.requirement_type === 'messages' && user.usage_count >= badge.requirement) shouldUnlock = true;
        else if (badge.requirement_type === 'streak' && (user.streak_count || 0) >= badge.requirement) shouldUnlock = true;
        else if (badge.requirement_type === 'images' && (user.images_generated || 0) >= badge.requirement) shouldUnlock = true;
        else if (badge.requirement_type === 'referrals' && (user.referrals_count || 0) >= badge.requirement) shouldUnlock = true;
        else if (badge.requirement_type === 'subscription' && (user.tier !== 'free' && user.tier !== 'starter')) shouldUnlock = true;

        if (shouldUnlock) {
            toInsert.push({ user_id: userId, badge_id: badge.id, unlocked_at: new Date().toISOString() });
            unlocked.push(badge);
        }
    }

    if (toInsert.length > 0) {
        await supabase.from('user_badges').insert(toInsert);
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
        } catch (e) {
            return `[PDF could not be read: ${e.message}]`;
        }
    } else if (mimeType === 'text/plain' || mimeType === 'text/csv') {
        return buffer.toString('utf-8');
    } else if (mimeType.startsWith('image/')) {
        return `[Image: ${file.originalname}]`;
    } else {
        try { return buffer.toString('utf-8'); } catch (e) { return `[File: ${file.originalname}]`; }
    }
}

// ============================================================
//  SYSTEM PROMPT BUILDER + SELF-CRITIQUE PASS
// ============================================================

function buildSystemPrompt({ memoryPrompt, languageInstruction }) {
    return `You are TechNovaphy AI, built for African freelancers, small businesses, and developers, with deep understanding of Kenyan and Nigerian markets.

RESPONSE FORMAT — you must always use this exact structure, for every reply, with no exceptions:

<thinking>
2-5 short sentences of genuine reasoning: what is the person actually asking, is anything ambiguous, what's the best structure or approach for this specific answer, and anything you should watch out for (uncertainty, missing info, risk of a wrong assumption). Be concrete and specific to this exact question — not generic.
</thinking>
<answer>
The full response the person will actually read. Nothing outside these tags is shown to them.
</answer>

CORE RULES (apply inside the <answer> tag):
1. Match length to the question. A yes/no or quick-fact question gets 1-3 sentences. A "how do I" or "explain" question gets real depth. Never pad an answer to seem more thorough than the question needs.
2. If a request is ambiguous, state your single most reasonable assumption in one short line, then proceed with a full answer. Do not stop and ask unless proceeding would clearly waste the person's time.
3. Default to plain prose in conversation. Only use bullet points, numbered steps, or tables when the content is genuinely structured (comparisons, sequential steps, data, code). Do not bullet-point a conversational reply.
4. On business, tax, legal, or financial topics: flag genuine uncertainty plainly ("I'm not fully certain here — worth confirming with...") rather than asserting confidently. A wrong confident answer costs the user money.
5. Ask at most one clarifying question, only when truly necessary, and never more than one per reply.
6. Do not open with throat-clearing ("Great question!", "I'd be happy to help!"). Start directly with substance.
7. When you don't know something or it may have changed recently, say so directly instead of guessing.

CONTEXT: You understand mobile money (M-Pesa, bank transfers), local currencies (KES, NGN), freelance platforms (Upwork, Fiverr), and small business realities specific to Kenya and Nigeria.

TONE: Professional, warm, direct. Not robotic, not falsely enthusiastic, not overly formal.

--- EXAMPLES OF THE STYLE YOU SHOULD MATCH INSIDE <answer> ---

User: "What's the capital of Kenya?"
Good: "Nairobi."
Bad: "Great question! The capital of Kenya is Nairobi, which is also the largest city in the country and serves as its political, economic, and cultural hub..."

User: "Should I register my business as a sole proprietorship or limited company in Kenya?"
Good: "Depends on your risk exposure and growth plans. A sole proprietorship is faster and cheaper to set up (just a business name registration at eCitizen) but you're personally liable for debts. A limited company (registered with the Business Registration Service) separates your personal assets from business liability and looks more credible to larger clients or investors, but has more compliance overhead — annual returns, separate tax filing. If you're freelancing solo with low liability risk, sole proprietorship is usually enough to start. If you're taking on contracts with real financial exposure or planning to hire, go limited. I'd recommend confirming current registration fees with the BRS directly since these do change."
Bad: [a bulleted list with generic pros/cons headers and no actual recommendation]

User: "fix this code" [pastes buggy code with no other context]
Good: [fixes the obvious bug, states the one-line assumption about what was intended, explains the fix in 2-3 sentences]
Bad: [asks 3 clarifying questions before attempting anything]

--- END EXAMPLES ---

Remember: EVERY reply must have both a <thinking> block and an <answer> block, even for simple greetings. Never skip the tags.
${memoryPrompt}
${languageInstruction}`;
}

// Parses the model's <thinking>...</thinking><answer>...</answer> output as it
// streams in. Works on partial/incomplete text (tags not yet closed) so it can
// be called after every chunk arrives, not just once at the end.
function parseThinkingAndAnswer(rawText) {
    const thinkClosed = rawText.match(/<thinking>([\s\S]*?)<\/thinking>/i);
    const thinkOpen = rawText.match(/<thinking>([\s\S]*)$/i);
    const answerClosed = rawText.match(/<answer>([\s\S]*?)<\/answer>/i);
    const answerOpen = rawText.match(/<answer>([\s\S]*)$/i);

    let thinking = '';
    let answer = '';

    if (thinkClosed) {
        thinking = thinkClosed[1];
    } else if (thinkOpen && !answerOpen) {
        thinking = thinkOpen[1];
    }

    if (answerClosed) {
        answer = answerClosed[1];
    } else if (answerOpen) {
        answer = answerOpen[1];
    }

    // Fallback: smaller models occasionally skip the tags entirely.
    // If nothing matched but there's real content, just treat it as the answer
    // so the user never sees a blank response.
    if (!thinking && !answer && rawText.trim()) {
        answer = rawText;
    }

    return { thinking: thinking.trim(), answer: answer.trim() };
}

// Runs a second, lightweight Groq call that reviews a generated draft
// for padding, overconfidence, and formatting issues before it's
// returned to the user. Used for template generation (proposals, cover
// letters, invoices) where users already expect a short wait and the
// polish directly affects whether their client-facing document lands
// well. NOT used in live chat streaming, where the latency cost isn't
// worth it for a conversational reply.
async function selfCritiquePass(draftAnswer, userQuestion, apiKey) {
    const critiquePrompt = `You are a strict editor. Review this draft answer to a user's request.

User's request: "${userQuestion}"

Draft:
"""
${draftAnswer}
"""

Check for:
- Unnecessary padding, repetition, or throat-clearing openers
- Overconfident claims on financial/legal/tax topics that should be hedged
- Bullet points used where plain prose would read better
- Anything factually questionable

If the draft is already good, reply with EXACTLY: OK
Otherwise, reply with ONLY the corrected version — no explanation, no preamble, just the fixed text.`;

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant', // small/fast model is enough for a critique pass
                messages: [{ role: 'user', content: critiquePrompt }],
                temperature: 0.3,
                max_tokens: 1024
            })
        });

        if (!response.ok) return draftAnswer; // fail safe: return original on any error

        const data = await response.json();
        const critiqueResult = data.choices?.[0]?.message?.content?.trim();

        if (!critiqueResult || critiqueResult === 'OK') {
            return draftAnswer;
        }
        return critiqueResult;
    } catch (err) {
        console.warn('⚠️ Self-critique pass failed, using original draft:', err.message);
        return draftAnswer; // never let this break the main response
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
    } catch (e) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
        let generatedContent = result.choices[0]?.message?.content || '';

        // Second pass: review the draft for padding, overconfidence, and
        // formatting before returning it. This is where the extra latency
        // is worth it — these are client-facing documents (proposals,
        // cover letters, invoices) where polish matters and the user
        // already expects a short generation wait.
        generatedContent = await selfCritiquePass(generatedContent, prompt, GROQ_API_KEY);

        res.json({ template_name: template.name, generated: generatedContent, shareable: true });
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  CHAT STREAM – WITH TRUNCATION
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
                catch (lockError) {
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
        catch (e) { return res.status(400).json({ error: 'Invalid messages format' }); }
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

        const systemPrompt = buildSystemPrompt({ memoryPrompt, languageInstruction });

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
            } catch (e) {}
            if (groqResponse.status === 413) {
                errorMessage = 'Your conversation is too long. Please start a new chat or shorten your message. (Token limit exceeded)';
            }
            throw new Error(errorMessage);
        }

        const reader = groqResponse.body.getReader();
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
                            // Re-derive thinking/answer from the full raw text so far.
                            // Both events send the CUMULATIVE text (not a delta) so the
                            // frontend can just set content directly rather than append —
                            // this keeps rendering correct even if tag boundaries land
                            // awkwardly across chunk splits.
                            const { thinking, answer } = parseThinkingAndAnswer(rawContent);
                            if (thinking) {
                                res.write(`data: ${JSON.stringify({ type: 'thinking', text: thinking })}\n\n`);
                            }
                            if (answer) {
                                res.write(`data: ${JSON.stringify({ type: 'chunk', text: answer })}\n\n`);
                            }
                        }
                    } catch (e) {}
                }
            }
        }

        const { thinking: finalThinking, answer: finalAnswer } = parseThinkingAndAnswer(rawContent);
        // Store only the clean answer in conversation history — the model
        // doesn't need to see its own <thinking> tags echoed back to it on
        // the next turn, and it keeps context usage lower.
        conversation.push({ role: 'assistant', content: finalAnswer });
        await saveConversation(user.id, conversation);

        // ---- Check badges ----
        const unlockedBadges = await checkAndUnlockBadges(user.id, user);

        const suggestions = generateSuggestions(finalAnswer);
        const upgrade_prompt = user.tier === 'free' && user.usage_count >= 50 ? {
            show: true,
            message: "You're loving this! Upgrade for unlimited messages"
        } : null;

        res.write(`data: ${JSON.stringify({
            type: 'done',
            text: finalAnswer,
            thinking: finalThinking,
            suggestions,
            points_earned: POINTS_PER_MESSAGE,
            badges_unlocked: unlockedBadges,
            upgrade_prompt
        })}\n\n`);
        res.end();

    } catch (err) {
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
    } catch (err) {
        console.error('❌ Image gen error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  PAYMENT – SUPPORTS NGN AND KES (subunit-correct)
// ============================================================

app.post('/api/create-checkout', auth, async (req, res) => {
    try {
        const { idempotencyKey, tier, currency } = req.body;
        const user = req.user;

        if (!idempotencyKey) {
            return res.status(400).json({ error: 'idempotencyKey is required' });
        }
        if (!tier || !['starter', 'pro', 'enterprise', 'ultimate'].includes(tier)) {
            return res.status(400).json({ error: 'Invalid tier selected.' });
        }

        console.log(`📦 Checkout request: tier=${tier}, currency=${currency}`);

        // ---- Determine final currency ----
        let finalCurrency = (currency || '').toUpperCase();
        if (!finalCurrency) {
            const userCountry = user.country || 'KE';
            finalCurrency = userCountry === 'NG' ? 'NGN' : 'KES';
        }

        const supportedCurrencies = ['KES', 'NGN', 'GHS', 'ZAR', 'EGP', 'RWF', 'TZS', 'UGX', 'XOF', 'XAF'];
        if (!supportedCurrencies.includes(finalCurrency)) {
            console.warn(`⚠️ Unsupported currency ${finalCurrency}, defaulting to KES`);
            finalCurrency = 'KES';
        }

        // ---- Step 1: get the human-readable amount in the target currency ----
        let humanAmount = TIER_PRICES_KES[tier]; // base price in KES

        if (finalCurrency !== 'KES') {
            const rates = await fetchExchangeRates();
            const rate = rates[finalCurrency];
            if (rate) {
                humanAmount = TIER_PRICES_KES[tier] * rate;
                console.log(`💱 ${TIER_PRICES_KES[tier]} KES → ${humanAmount.toFixed(2)} ${finalCurrency}`);
            } else {
                console.warn(`⚠️ Rate missing for ${finalCurrency}, defaulting to KES`);
                finalCurrency = 'KES';
                humanAmount = TIER_PRICES_KES[tier];
            }
        }

        // ---- Step 2: convert to Paystack's subunit format ONCE, for every currency ----
        // Paystack requires amounts in the smallest unit of the currency
        // (kobo for NGN, cents for KES, pesewas for GHS, etc.) — no exceptions.
        const amount = Math.round(humanAmount * 100);

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
                amount: amount, // subunit amount
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

        // ---- Record payment. Store the SUBUNIT amount so the webhook's
        // amount comparison (Paystack also sends subunits) matches exactly. ----
        await supabase.from('payments').insert({
            user_id: user.id,
            transaction_id: idempotencyKey,
            amount: amount,
            currency: finalCurrency,
            status: 'pending',
            tier
        });

        console.log(`✅ Payment initialized: ${amount} ${finalCurrency} subunits for ${tier}`);
        res.json({ url: data.data.authorization_url });
    } catch (err) {
        console.error('❌ Checkout error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  START SERVER
// ============================================================

app.listen(PORT, () => console.log(`🚀 TechNovaphy AI Backend running on port ${PORT}`));
