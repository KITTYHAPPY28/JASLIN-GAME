import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { createClient } from "@supabase/supabase-js";

import { Address, beginCell, toNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import {
  TonClient,
  JettonMaster,
  WalletContractV4,
  WalletContractV5R1
} from "@ton/ton";

dotenv.config();


/* =========================================
   BASIC SETUP
========================================= */

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

const app =
  express();

const PORT =
  Number(process.env.PORT || 3000);


/* =========================================
   ENVIRONMENT VARIABLES
========================================= */

const BOT_TOKEN =
  process.env.BOT_TOKEN || "";

const BOT_USERNAME =
  process.env.BOT_USERNAME ||
  "JaslinEarnBot";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "";

const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY || "";

const MINING_PER_MINUTE =
  Number(
    process.env.MINING_PER_MINUTE ||
    (100 / 480)
  );

const DAILY_SPIN_REWARD =
  Number(
    process.env.DAILY_SPIN_REWARD ||
    25
  );

const REFERRAL_REWARD =
  Number(
    process.env.REFERRAL_REWARD ||
    200
  );

const REFERRAL_COMMISSION_RATE =
  Math.min(
    1,
    Math.max(
      0,
      Number(
        process.env.REFERRAL_COMMISSION_RATE ||
        0.10
      )
    )
  );

const TON_TREASURY_MNEMONIC =
  process.env.TON_TREASURY_MNEMONIC ||
  "";

const TON_TREASURY_ADDRESS =
  process.env.TON_TREASURY_ADDRESS ||
  "";

const TON_NETWORK =
  process.env.TON_NETWORK ||
  "mainnet";

const TON_RPC_URL =
  process.env.TON_RPC_URL || "https://toncenter.com/api/v2/jsonRPC";

const TONCENTER_API_KEY =
  process.env.TONCENTER_API_KEY;

// Protect private treasury diagnostics in production.
const TREASURY_ADMIN_KEY =
  process.env.TREASURY_ADMIN_KEY ||
  "";

// Public operational controls.
const MAINTENANCE_MODE =
  String(process.env.MAINTENANCE_MODE || "false")
    .toLowerCase() === "true";

const ANNOUNCEMENT_TITLE =
  String(process.env.ANNOUNCEMENT_TITLE || "").trim();

const ANNOUNCEMENT_MESSAGE =
  String(process.env.ANNOUNCEMENT_MESSAGE || "").trim();

/* =========================================
   JASLIN TOKEN
========================================= */

const JASLIN_JETTON_MASTER =
  "EQAmDnasFQqqiEFBjHy4tI0iIw1r-OtFeOSa0J9CJ4fNhjjx";

const tonClient = new TonClient({
  endpoint: TON_RPC_URL,
  apiKey: TONCENTER_API_KEY
});

function safeErrorDetails(error) {
  return {
    message: error?.message || String(error || "Unknown error"),
    code: error?.code || null,
    status: error?.response?.status || null
  };
}

const JASLIN_DECIMALS = 9;

const MIN_WITHDRAW_JASLIN = 2000;
const WITHDRAW_FEE_JASLIN = 300;
const WITHDRAWALS_ENABLED =
  String(process.env.WITHDRAWALS_ENABLED || "false")
    .toLowerCase() === "true";

const MAX_LEVEL = 5000;

// JASLIN Core Holding curve.
// Lv2 starts at 200 JASLIN. Lv5000 is designed as an elite tier.
const LEVEL_HOLDING_BASE_JASLIN = 200;
const LEVEL_HOLDING_EXPONENT = 1.73;

// Core Pulse burst system.
// Tap 1 = 1/3 (no boost), Tap 2 = 2/3 (no boost),
// Tap 3 = MAX x1.10 for exactly 5 seconds, then reset.
const PULSE_TAP_WINDOW_MS = 5000;
const PULSE_BOOST_DURATION_MS = 5000;
const PULSE_MAX_MULTIPLIER = 1.10;
const PULSE_LOOKBACK_MS = PULSE_TAP_WINDOW_MS + PULSE_BOOST_DURATION_MS;

function requiredHoldingJaslin(targetLevel) {
  const level = Math.min(
    MAX_LEVEL,
    Math.max(2, Number(targetLevel || 2))
  );

  const n = level - 1;

  return Math.round(
    LEVEL_HOLDING_BASE_JASLIN *
    Math.pow(n, LEVEL_HOLDING_EXPONENT)
  );
}

function levelSpeedMultiplier(levelValue) {
  const level = Math.min(
    MAX_LEVEL,
    Math.max(1, Number(levelValue || 1))
  );

  // Lv1 = 1.00x, Lv5000 = 3.00x.
  return 1 +
    2 * ((level - 1) / (MAX_LEVEL - 1));
}

function coreRank(levelValue) {
  const level = Number(levelValue || 1);
  if (level >= 5000) return "GENESIS";
  if (level >= 4000) return "NOVA";
  if (level >= 3000) return "QUANTUM";
  if (level >= 2000) return "VORTEX";
  if (level >= 1000) return "APEX";
  if (level >= 500) return "PRIME";
  if (level >= 100) return "FORGE";
  return "SPARK";
}

/* =========================================
   SUPABASE
========================================= */

const supabase =
  createClient(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  );


/* =========================================
   EXPRESS
========================================= */

app.use(
  express.json()
);

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);


/* =========================================
   BASIC API PROTECTION
   First layer only. On serverless this map is per instance.
========================================= */

const rateBuckets = new Map();

function createRateLimit({ windowMs, max, prefix }) {
  return (req, res, next) => {
    const identity =
      String(req.tgUser?.id || req.headers["x-forwarded-for"] || req.ip || "guest");
    const key = `${prefix}:${identity}`;
    const now = Date.now();
    const current = rateBuckets.get(key);

    if (!current || now >= current.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (current.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: `Terlalu banyak request. Coba lagi dalam ${retryAfter} detik.`
      });
    }

    current.count += 1;
    rateBuckets.set(key, current);
    next();
  };
}

function maintenanceGuard(req, res, next) {
  if (!MAINTENANCE_MODE) return next();

  return res.status(503).json({
    error: "JASLIN sedang maintenance. Coba lagi sebentar lagi.",
    maintenance: true
  });
}

const limitClaim = createRateLimit({ windowMs: 60_000, max: 4, prefix: "claim" });
const limitSpin = createRateLimit({ windowMs: 60_000, max: 4, prefix: "spin" });
const limitUpgrade = createRateLimit({ windowMs: 60_000, max: 12, prefix: "upgrade" });
const limitPulse = createRateLimit({ windowMs: 10_000, max: 8, prefix: "pulse" });
const limitReferralClaim = createRateLimit({ windowMs: 60_000, max: 4, prefix: "refclaim" });
const limitWallet = createRateLimit({ windowMs: 60_000, max: 12, prefix: "wallet" });
const limitWithdraw = createRateLimit({ windowMs: 60_000, max: 3, prefix: "withdraw" });

/* =========================================
   TELEGRAM AUTH
========================================= */

function verifyTelegramInitData(
  initData
) {

  if (
    !BOT_TOKEN ||
    !initData
  ) {
    return null;
  }

  const params =
    new URLSearchParams(
      initData
    );

  const hash =
    params.get("hash");

  const authDate =
    Number(
      params.get(
        "auth_date"
      )
    );

  if (
    !hash ||
    !authDate
  ) {
    return null;
  }

  const now =
    Math.floor(
      Date.now() /
      1000
    );

  // Reject stale initData and timestamps too far in the future.
  if (
    authDate > now + 60 ||
    now - authDate > 86400
  ) {
    return null;
  }

  params.delete(
    "hash"
  );

  const dataCheckString =
    [...params.entries()]
      .sort(
        ([a], [b]) =>
          a.localeCompare(b)
      )
      .map(
        ([key, value]) =>
          `${key}=${value}`
      )
      .join("\n");

  const secretKey =
    crypto
      .createHmac(
        "sha256",
        "WebAppData"
      )
      .update(
        BOT_TOKEN
      )
      .digest();

  const calculatedHash =
    crypto
      .createHmac(
        "sha256",
        secretKey
      )
      .update(
        dataCheckString
      )
      .digest(
        "hex"
      );

  try {

    const valid =
      crypto.timingSafeEqual(
        Buffer.from(
          calculatedHash,
          "hex"
        ),
        Buffer.from(
          hash,
          "hex"
        )
      );

    if (!valid) {
      return null;
    }

  } catch {

    return null;

  }

  const userData =
    params.get(
      "user"
    );

  if (!userData) {
    return null;
  }

  try {

    return JSON.parse(
      userData
    );

  } catch {

    return null;

  }
}


/* =========================================
   AUTH MIDDLEWARE
========================================= */

function auth(
  req,
  res,
  next
) {

  const initData =
    req.headers[
      "x-telegram-init-data"
    ] || "";

  const user =
    verifyTelegramInitData(
      initData
    );

  if (!user?.id) {

    return res
      .status(401)
      .json({
        error:
          "Telegram authentication gagal."
      });

  }

  req.tgUser =
    user;

  next();
}



/* =========================================
   TREASURY ADMIN AUTH
========================================= */

function treasuryAdminAuth(req, res, next) {
  if (!TREASURY_ADMIN_KEY) {
    return res.status(503).json({
      ok: false,
      error: "Treasury diagnostics dinonaktifkan."
    });
  }

  const provided = String(req.headers["x-admin-key"] || "");

  try {
    const expectedBuffer = Buffer.from(TREASURY_ADMIN_KEY);
    const providedBuffer = Buffer.from(provided);

    if (
      expectedBuffer.length !== providedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      return res.status(403).json({
        ok: false,
        error: "Akses treasury ditolak."
      });
    }
  } catch {
    return res.status(403).json({
      ok: false,
      error: "Akses treasury ditolak."
    });
  }

  next();
}

/* =========================================
   GET USER
========================================= */

async function getUser(
  id
) {

  const {
    data,
    error
  } =
    await supabase
      .from("users")
      .select("*")
      .eq(
        "telegram_id",
        String(id)
      )
      .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}


/* =========================================
   SAFE BALANCE DELTA
   Optimistic concurrency without DB RPC.
========================================= */

async function applyBalanceDelta(telegramId, delta, maxRetries = 5) {
  const id = String(telegramId);
  const change = Number(delta || 0);

  if (!Number.isFinite(change)) {
    throw new Error("Balance delta tidak valid.");
  }

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const current = await getUser(id);

    if (!current) {
      throw new Error("User balance target tidak ditemukan.");
    }

    const oldBalance = Number(current.balance || 0);
    const newBalance = oldBalance + change;

    if (newBalance < 0) {
      throw new Error("Saldo tidak mencukupi.");
    }

    const { data, error } = await supabase
      .from("users")
      .update({ balance: newBalance })
      .eq("telegram_id", id)
      .eq("balance", current.balance)
      .select("telegram_id")
      .maybeSingle();

    if (error) throw error;
    if (data) return newBalance;
  }

  throw new Error("Saldo sedang berubah. Coba lagi.");
}



async function applyReferralCommissionDelta(telegramId, delta, maxRetries = 5) {
  const id = String(telegramId);
  const change = Number(delta || 0);

  if (!Number.isFinite(change)) {
    throw new Error("Referral commission delta tidak valid.");
  }

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const current = await getUser(id);

    if (!current) {
      throw new Error("User referral tidak ditemukan.");
    }

    const oldCommission = Number(current.referral_commission_balance || 0);
    const newCommission = oldCommission + change;

    if (newCommission < 0) {
      throw new Error("Referral commission tidak mencukupi.");
    }

    const { data, error } = await supabase
      .from("users")
      .update({ referral_commission_balance: newCommission })
      .eq("telegram_id", id)
      .eq("referral_commission_balance", current.referral_commission_balance ?? 0)
      .select("telegram_id")
      .maybeSingle();

    if (error) throw error;
    if (data) return newCommission;
  }

  throw new Error("Referral commission sedang berubah. Coba lagi.");
}

/* =========================================
   SAVE TRANSACTION
========================================= */

async function saveTransaction(
  telegramId,
  type,
  amount,
  note = "",
  txSignature = null,
  status = "completed"
) {

  const {
    error
  } =
    await supabase
      .from(
        "transactions"
      )
      .insert({

        telegram_id:
          String(
            telegramId
          ),

        type:
          type,

        amount:
          Number(
            amount
          ),

        status:
          status,

        tx_signature:
          txSignature,

        note:
          note,

        created_at:
          Date.now()

      });

  if (error) {

    console.error(
      "Transaction error:",
      error.message
    );

  }
}


/* =========================================
   MINING CALCULATION
========================================= */

async function getPulseEvents(telegramId, startAt, endAt) {
  const from = Math.max(0, startAt - PULSE_LOOKBACK_MS);

  const { data, error } =
    await supabase
      .from("transactions")
      .select("created_at")
      .eq("telegram_id", String(telegramId))
      .eq("type", "core_pulse")
      .gte("created_at", from)
      .lte("created_at", endAt)
      .order("created_at", { ascending: true });

  if (error) {
    console.error("Pulse history error:", error.message);
    return [];
  }

  return (data || [])
    .map((row) => Number(row.created_at))
    .filter(Number.isFinite);
}

function pulseStateFromEvents(events, atTime) {
  let tapCount = 0;
  let firstTapAt = 0;
  let pulseExpiresAt = 0;

  for (const pulseAt of events) {
    if (pulseAt > atTime) break;

    // Ignore taps that happened while MAX boost was active.
    if (pulseExpiresAt && pulseAt < pulseExpiresAt) {
      continue;
    }

    // A finished MAX cycle always resets to 0/3.
    if (pulseExpiresAt && pulseAt >= pulseExpiresAt) {
      tapCount = 0;
      firstTapAt = 0;
      pulseExpiresAt = 0;
    }

    // First tap, or restart the chain if taps were too far apart.
    if (!firstTapAt || pulseAt - firstTapAt > PULSE_TAP_WINDOW_MS) {
      tapCount = 1;
      firstTapAt = pulseAt;
      continue;
    }

    tapCount += 1;

    // Only the third tap activates mining boost.
    if (tapCount >= 3) {
      tapCount = 3;
      pulseExpiresAt = pulseAt + PULSE_BOOST_DURATION_MS;
    }
  }

  const pulseActive =
    pulseExpiresAt > 0 && atTime < pulseExpiresAt;

  // Expired boost or expired tap chain -> READY / 0/3.
  if (pulseExpiresAt && atTime >= pulseExpiresAt) {
    tapCount = 0;
    firstTapAt = 0;
    pulseExpiresAt = 0;
  } else if (
    !pulseActive &&
    firstTapAt &&
    atTime - firstTapAt > PULSE_TAP_WINDOW_MS
  ) {
    tapCount = 0;
    firstTapAt = 0;
  }

  return {
    pulseLevel: tapCount,
    pulseTapCount: tapCount,
    pulseActive,
    pulseMultiplier: pulseActive ? PULSE_MAX_MULTIPLIER : 1,
    pulseExpiresAt,
    pulseRemainingMs: pulseActive
      ? Math.max(0, pulseExpiresAt - atTime)
      : 0
  };
}

async function getPulseStatus(telegramId) {
  const now = Date.now();
  const events = await getPulseEvents(
    telegramId,
    now - PULSE_LOOKBACK_MS,
    now
  );

  return pulseStateFromEvents(events, now);
}

async function calculateMining(user) {
  const started = Number(user.mining_started_at || Date.now());
  const now = Date.now();

  // Maximum one mining cycle: 8 hours.
  const MAX_MINING_TIME = 8 * 60 * 60 * 1000;
  const endAt = Math.min(now, started + MAX_MINING_TIME);
  const startAt = Math.min(started, endAt);

  if (endAt <= startAt) return 0;

  const levelMultiplier = levelSpeedMultiplier(user.level);
  const basePerMs =
    (MINING_PER_MINUTE * levelMultiplier) / 60000;

  const pulseEvents = await getPulseEvents(
    user.telegram_id,
    startAt,
    endAt
  );

  const boundaries = new Set([startAt, endAt]);

  // Every tap can become the third tap, so add tap time and
  // possible MAX expiry as boundaries. The state function decides
  // whether that tap actually activated the boost.
  for (const pulseAt of pulseEvents) {
    if (pulseAt >= startAt && pulseAt <= endAt) {
      boundaries.add(pulseAt);
    }

    const expiry = pulseAt + PULSE_BOOST_DURATION_MS;
    if (expiry > startAt && expiry < endAt) {
      boundaries.add(expiry);
    }
  }

  const points = [...boundaries].sort((a, b) => a - b);
  let reward = 0;

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const midpoint = a + (b - a) / 2;
    const pulse = pulseStateFromEvents(pulseEvents, midpoint);

    reward +=
      (b - a) *
      basePerMs *
      pulse.pulseMultiplier;
  }

  return reward;
}


/* =========================================
   CREATE / UPDATE USER
========================================= */

async function ensureUser(
  telegramUser,
  referralCode
) {

  const telegramId =
    String(
      telegramUser.id
    );

  let user =
    await getUser(
      telegramId
    );


  /* USER SUDAH ADA */

  if (user) {

    // Return the updated row directly so login does not need
    // another Supabase SELECT after updating last_seen/profile.
    const {
      data: updatedUser,
      error
    } =
      await supabase
        .from("users")
        .update({

          username:
            telegramUser.username ||
            "",

          first_name:
            telegramUser.first_name ||
            "",

          last_seen_at:
            Date.now()

        })
        .eq(
          "telegram_id",
          telegramId
        )
        .select("*")
        .maybeSingle();

    if (error) {
      throw error;
    }

    return updatedUser || user;
  }


  /* REFERRAL */

  let referredBy =
    null;

  if (
    referralCode &&
    referralCode !==
    telegramId
  ) {

    const referrer =
      await getUser(
        referralCode
      );

    if (referrer) {
      referredBy =
        referralCode;
    }

  }


  const createdAt =
    Date.now();


  /* CREATE USER */

  const {
    data: createdUser,
    error
  } =
    await supabase
      .from("users")
      .insert({

        telegram_id:
          telegramId,

        username:
          telegramUser.username ||
          "",

        first_name:
          telegramUser.first_name ||
          "",

        wallet:
          "",

        balance:
          0,

        mining_started_at:
          createdAt,

        last_spin_at:
          0,

        referred_by:
          referredBy,

        referral_commission_balance:
          0,

        last_seen_at:
          createdAt,

        created_at:
          createdAt

      })
      .select("*")
      .single();

  if (error) {
    throw error;
  }


  /* REFERRAL BONUS */

  if (referredBy) {

    const referrer =
      await getUser(
        referredBy
      );

    if (referrer) {
      await applyBalanceDelta(
        referredBy,
        REFERRAL_REWARD
      );

      await saveTransaction(
        referredBy,
        "referral",
        REFERRAL_REWARD,
        `Referral dari ${telegramId}`
      );

    }

  }

  return createdUser;
}


/* =========================================
   PUBLIC STATE
========================================= */

async function publicState(user) {
  const mining = await calculateMining(user);

  const lastSpin = Number(user.last_spin_at || 0);
  const spinAvailable =
    !lastSpin ||
    (Date.now() - lastSpin) >= 86400000;

  const level = Math.min(
    MAX_LEVEL,
    Math.max(1, Number(user.level || 1))
  );

  const pulse = await getPulseStatus(user.telegram_id);
  const baseRate =
    MINING_PER_MINUTE * levelSpeedMultiplier(level);
  const effectiveRate =
    baseRate * pulse.pulseMultiplier;

  let referralCount = 0;
  try {
    const { count } = await supabase
      .from("users")
      .select("telegram_id", { count: "exact", head: true })
      .eq("referred_by", String(user.telegram_id));
    referralCount = Number(count || 0);
  } catch (error) {
    console.error("Referral count error:", error);
  }

  const miningStartedAt = Number(user.mining_started_at || Date.now());
  const miningCapAt = miningStartedAt + 8 * 60 * 60 * 1000;

  return {
    user: {
      id: user.telegram_id,
      username: user.username,
      firstName: user.first_name,
      wallet: user.wallet || ""
    },

    balance: Number(Number(user.balance).toFixed(4)),
    mining: Number(mining.toFixed(8)),

    miningPerMinute: Number(effectiveRate.toFixed(8)),
    baseMiningPerMinute: Number(baseRate.toFixed(8)),
    eightHourOutput: Number((baseRate * 480).toFixed(4)),

    miningStartedAt,
    miningCapAt,

    pulseLevel: pulse.pulseLevel,
    pulseMultiplier: pulse.pulseMultiplier,
    pulseExpiresAt: pulse.pulseExpiresAt,

    dailySpinAvailable: spinAvailable,
    referralCount,
    referralCommissionBalance:
      Number(Number(user.referral_commission_balance || 0).toFixed(8)),
    referralCommissionRate:
      REFERRAL_COMMISSION_RATE,
    referralLink:
      `https://t.me/${BOT_USERNAME}?startapp=ref_${user.telegram_id}`,

    network: "TON",
    jetton: JASLIN_JETTON_MASTER,

    minimumWithdraw: MIN_WITHDRAW_JASLIN,
    withdrawFee: WITHDRAW_FEE_JASLIN,
    withdrawalsEnabled: WITHDRAWALS_ENABLED,

    level,
    maxLevel: MAX_LEVEL,
    coreRank: coreRank(level)
  };
}


/* =========================================
   PUBLIC APP CONFIG
========================================= */

app.get("/api/config", (req, res) => {
  res.json({
    game: "JASLIN",
    maintenance: MAINTENANCE_MODE,
    announcement: {
      title: ANNOUNCEMENT_TITLE,
      message: ANNOUNCEMENT_MESSAGE,
      active: Boolean(ANNOUNCEMENT_TITLE || ANNOUNCEMENT_MESSAGE)
    },
    withdrawalsEnabled: WITHDRAWALS_ENABLED,
    minimumWithdraw: MIN_WITHDRAW_JASLIN,
    withdrawFee: WITHDRAW_FEE_JASLIN
  });
});

/* =========================================
   SESSION
========================================= */

app.post(
  "/api/session",
  auth,
  async (
    req,
    res
  ) => {

    try {

      const startParam =
        String(
          req.body
            ?.startParam ||
          ""
        );

      let referralCode =
        "";

      if (
        startParam.startsWith(
          "ref_"
        )
      ) {

        referralCode =
          startParam.substring(
            4
          );

      }

      const user =
        await ensureUser(
          req.tgUser,
          referralCode
        );

      res.json(
        await publicState(
          user
        )
      );

    } catch (
      error
    ) {

      console.error(
        error
      );

      res
        .status(500)
        .json({
          error:
            "Gagal membuat session."
        });

    }

  }
);


/* =========================================
   STATE
========================================= */

app.get(
  "/api/state",
  auth,
  async (
    req,
    res
  ) => {

    try {

      let user =
        await getUser(
          req.tgUser.id
        );

      if (!user) {

        return res
          .status(404)
          .json({
            error:
              "User belum terdaftar."
          });

      }

      const { data: seenUser, error: seenError } = await supabase
        .from("users")
        .update({ last_seen_at: Date.now() })
        .eq("telegram_id", String(req.tgUser.id))
        .select("*")
        .maybeSingle();

      if (seenError) throw seenError;
      if (seenUser) user = seenUser;

      res.json(
        await publicState(
          user
        )
      );

    } catch (
      error
    ) {

      console.error(
        error
      );

      res
        .status(500)
        .json({
          error:
            "Gagal mengambil data."
        });

    }

  }
);


/* =========================================
   CLAIM MINING
========================================= */

app.post(
  "/api/claim",
  auth,
  maintenanceGuard,
  limitClaim,
  async (req, res) => {
    try {
      const user = await getUser(req.tgUser.id);

      if (!user) {
        return res.status(404).json({
          error: "User tidak ditemukan."
        });
      }

      const claimed = Number(
        (await calculateMining(user)).toFixed(8)
      );

      if (claimed <= 0) {
        return res.status(400).json({
          error: "Belum ada mining."
        });
      }

      const now = Date.now();
      const currentBalance = Number(user.balance || 0);
      const newBalance = currentBalance + claimed;

      // Prevent double claim from simultaneous requests.
      const { data: claimedUser, error: claimError } =
        await supabase
          .from("users")
          .update({
            balance: newBalance,
            mining_started_at: now
          })
          .eq("telegram_id", String(req.tgUser.id))
          .eq("balance", user.balance)
          .eq("mining_started_at", user.mining_started_at)
          .select("telegram_id")
          .maybeSingle();

      if (claimError) throw claimError;

      if (!claimedUser) {
        return res.status(409).json({
          error: "Claim sedang diproses atau saldo berubah. Coba lagi."
        });
      }

      await saveTransaction(
        req.tgUser.id,
        "mining",
        claimed,
        "Mining claim"
      );

      // Direct referral only: inviter earns 10% of invitee's claimed mining.
      // Invitee keeps 100% of their own claim.
      let referralCommission = 0;

      if (user.referred_by) {
        referralCommission = Number(
          (claimed * REFERRAL_COMMISSION_RATE).toFixed(8)
        );

        if (referralCommission > 0) {
          await applyReferralCommissionDelta(
            user.referred_by,
            referralCommission
          );

          await saveTransaction(
            user.referred_by,
            "referral_commission_pending",
            referralCommission,
            `${Math.round(REFERRAL_COMMISSION_RATE * 100)}% mining commission dari ${req.tgUser.id}`
          );
        }
      }

      const updated = await getUser(req.tgUser.id);

      res.json({
        ...await publicState(updated),
        claimed: Number(claimed.toFixed(4)),
        referralCommissionPaid: referralCommission
      });

    } catch (error) {
      console.error("Claim mining error:", error);

      res.status(500).json({
        error: error?.message || "Claim mining gagal."
      });
    }
  }
);


/* =========================================
   DAILY SPIN
========================================= */

app.post(
  "/api/spin",
  auth,
  maintenanceGuard,
  limitSpin,
  async (
    req,
    res
  ) => {

    try {

      const user =
        await getUser(
          req.tgUser.id
        );

      if (!user) {

        return res
          .status(404)
          .json({
            error:
              "User tidak ditemukan."
          });

      }

      const lastSpin =
        Number(
          user.last_spin_at
        );

      if (
        lastSpin &&
        Date.now() -
        lastSpin <
        86400000
      ) {

        return res
          .status(400)
          .json({
            error:
              "Daily Spin sudah digunakan."
          });

      }

      // Daily Core Drop: controlled weighted reward.
      const roll = Math.random() * 100;

      let reward = 10;
      let rarity = "COMMON";

      if (roll < 2) {
        reward = 100;
        rarity = "LEGENDARY";
      } else if (roll < 8) {
        reward = 50;
        rarity = "EPIC";
      } else if (roll < 20) {
        reward = 30;
        rarity = "RARE";
      } else if (roll < 45) {
        reward = 20;
        rarity = "UNCOMMON";
      }

      const newBalance =
        Number(
          user.balance
        ) +
        reward;

      const now =
        Date.now();

      const { data: spinUser, error } =
        await supabase
          .from("users")
          .update({
            balance: newBalance,
            last_spin_at: now
          })
          .eq("telegram_id", String(req.tgUser.id))
          .eq("balance", user.balance)
          .eq("last_spin_at", user.last_spin_at)
          .select("telegram_id")
          .maybeSingle();

      if (error) {
        throw error;
      }

      if (!spinUser) {
        return res.status(409).json({
          error: "Daily Spin sedang diproses. Muat ulang lalu coba lagi."
        });
      }

      await saveTransaction(
        req.tgUser.id,
        "daily_spin",
        reward,
        "Daily Spin"
      );

      const updated =
        await getUser(
          req.tgUser.id
        );

      res.json({

        ...await publicState(
          updated
        ),

        reward,
        rarity

      });

    } catch (
      error
    ) {

      console.error(
        error
      );

      res
        .status(500)
        .json({
          error:
            "Daily Spin gagal."
        });

    }

  }
); 

/* =========================================
   JASLIN MARKET PRICE - DEDUST CPMM V2
========================================= */

app.get("/api/jaslin-price", async (req, res) => {
  try {
    const poolAddress = Address.parse(
      "EQBtaODtADXS7R6KJClA_-uOQlFkXG8_GCjjVfk4vUbMImxb"
    );

    const result = await tonClient.runMethod(
      poolAddress,
      "get_pool_data"
    );

    const items = result.stack.items;

// Reserve CPMM v2 dari output pool kita
const reserveX = BigInt(items[9].value);
const reserveY = BigInt(items[10].value);

// Kedua token memakai 9 decimals.
// Pool ini: X = GRAM, Y = JASLIN.
const gramReserve = Number(reserveX) / 1e9;
const jaslinReserve = Number(reserveY) / 1e9;

const priceGram =
  gramReserve / jaslinReserve;

const jaslinPerGram =
  jaslinReserve / gramReserve;
const gramPriceResponse = await fetch(
  "https://api.coingecko.com/api/v3/simple/price?names=Gram%20%28prev.%20Toncoin%29&vs_currencies=usd"
);

if (!gramPriceResponse.ok) {
  throw new Error("Gagal mengambil harga GRAM/USD");
}

const gramPriceData =
  await gramPriceResponse.json();

const gramPriceUsd =
  Number(
    gramPriceData?.["Gram (prev. Toncoin)"]?.usd || 0
  );

const priceUsd =
  priceGram * gramPriceUsd;
    
res.json({
  ok: true,
  symbol: "JASLIN",
  pair: "JASLIN/GRAM",
  source: "dedust_onchain",

  jaslinReserve,
  gramReserve,

  priceGram,
  jaslinPerGram,

  gramPriceUsd,
  priceUsd,

  updatedAt: Date.now()
});

  } catch (error) {
    console.error("JASLIN pool error:", safeErrorDetails(error));

    res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

/* =========================================
   LEVEL QUOTE
========================================= */


/* =========================================
   LEVEL QUOTE - HOLDING POWER
========================================= */

app.post(
  "/api/level-quote",
  auth,
  async (req, res) => {
    try {
      const user =
        await getUser(
          req.tgUser.id
        );

      if (!user) {
        return res.status(404).json({
          error: "User tidak ditemukan."
        });
      }

      const currentLevel =
        Math.min(
          MAX_LEVEL,
          Math.max(
            1,
            Number(user.level || 1)
          )
        );

      const targetLevel =
        Math.floor(
          Number(req.body?.targetLevel)
        );

      if (
        !Number.isFinite(targetLevel) ||
        targetLevel <= currentLevel ||
        targetLevel > MAX_LEVEL
      ) {
        return res.status(400).json({
          error: "Target level tidak valid."
        });
      }

      const gameBalance =
        Number(user.balance || 0);

      let walletBalance = 0;

      if (user.wallet) {
        try {
          const ownerAddress =
            Address.parse(user.wallet);

          const master =
            tonClient.open(
              JettonMaster.create(
                Address.parse(
                  JASLIN_JETTON_MASTER
                )
              )
            );

          const jettonWalletAddress =
            await master.getWalletAddress(
              ownerAddress
            );

          const walletData =
            await tonClient.runMethod(
              jettonWalletAddress,
              "get_wallet_data"
            );

          const rawBalance =
            BigInt(
              walletData.stack.items[0].value
            );

          walletBalance =
            Number(rawBalance) /
            (10 ** JASLIN_DECIMALS);

        } catch (error) {
          console.error(
            "Level quote wallet error:",
            safeErrorDetails(error)
          );

          walletBalance = 0;
        }
      }

      const totalHoldingJaslin =
        gameBalance + walletBalance;

      const poolAddress =
        Address.parse(
          "EQBtaODtADXS7R6KJClA_-uOQlFkXG8_GCjjVfk4vUbMImxb"
        );

      const poolResult =
        await tonClient.runMethod(
          poolAddress,
          "get_pool_data"
        );

      const items =
        poolResult.stack.items;

      const reserveX =
        BigInt(items[9].value);

      const reserveY =
        BigInt(items[10].value);

      const gramReserve =
        Number(reserveX) / 1e9;

      const jaslinReserve =
        Number(reserveY) / 1e9;

      const priceGram =
        gramReserve / jaslinReserve;

      const holdingPowerGram =
        totalHoldingJaslin * priceGram;

      const requiredJaslin =
        requiredHoldingJaslin(targetLevel);

      const requiredGram =
        requiredJaslin * priceGram;

      const missingJaslin =
        Math.max(
          0,
          requiredJaslin - totalHoldingJaslin
        );

      const missingGram =
        missingJaslin * priceGram;

      res.json({
        ok: true,

        currentLevel,
        targetLevel,

        gameBalance,
        walletBalance,
        totalHoldingJaslin,

        priceGram,

        holdingPowerGram,
        requiredGram,

        requiredJaslin,
        missingGram,
        missingJaslin,

        eligible:
          totalHoldingJaslin >=
          requiredJaslin
      });

    } catch (error) {
      console.error(
        "Level quote error:",
        safeErrorDetails(error)
      );

      res.status(500).json({
        error:
          "Gagal menghitung Holding Power."
      });
    }
  }
);


/* =========================================
   UPGRADE CORE - HOLDING POWER
========================================= */

app.post(
  "/api/upgrade-core",
  auth,
  maintenanceGuard,
  limitUpgrade,
  async (req, res) => {
    try {
      const user = await getUser(req.tgUser.id);

      if (!user) {
        return res.status(404).json({
          error: "User tidak ditemukan."
        });
      }

      const currentLevel = Math.min(
        MAX_LEVEL,
        Math.max(1, Number(user.level || 1))
      );

      if (currentLevel >= MAX_LEVEL) {
        return res.status(400).json({
          error: "Level maksimum sudah tercapai."
        });
      }

      const targetLevel = currentLevel + 1;

      /* SALDO GAME */

      const gameBalance =
        Number(user.balance || 0);

      /* SALDO JASLIN WALLET */

      let walletBalance = 0;

      if (user.wallet) {
        try {
          const ownerAddress =
            Address.parse(user.wallet);

          const master =
            tonClient.open(
              JettonMaster.create(
                Address.parse(
                  JASLIN_JETTON_MASTER
                )
              )
            );

          const jettonWalletAddress =
            await master.getWalletAddress(
              ownerAddress
            );

          const walletData =
            await tonClient.runMethod(
              jettonWalletAddress,
              "get_wallet_data"
            );

          const rawBalance =
            BigInt(
              walletData.stack.items[0].value
            );

          walletBalance =
            Number(rawBalance) /
            (10 ** JASLIN_DECIMALS);

        } catch (error) {
          console.error(
            "JASLIN wallet balance error:",
            safeErrorDetails(error)
          );

          walletBalance = 0;
        }
      }

      /* TOTAL HOLDING */

      const totalHoldingJaslin =
        gameBalance + walletBalance;

      /* RATE JASLIN / GRAM DARI POOL */

      const poolAddress =
        Address.parse(
          "EQBtaODtADXS7R6KJClA_-uOQlFkXG8_GCjjVfk4vUbMImxb"
        );

      const poolResult =
        await tonClient.runMethod(
          poolAddress,
          "get_pool_data"
        );

      const items =
        poolResult.stack.items;

      const reserveX =
        BigInt(items[9].value);

      const reserveY =
        BigInt(items[10].value);

      // X = GRAM, Y = JASLIN
      const gramReserve =
        Number(reserveX) / 1e9;

      const jaslinReserve =
        Number(reserveY) / 1e9;

      const priceGram =
        gramReserve / jaslinReserve;

      /* HOLDING POWER */

      const holdingPowerGram =
        totalHoldingJaslin * priceGram;

      const requiredJaslin =
        requiredHoldingJaslin(targetLevel);

      const requiredGram =
        requiredJaslin * priceGram;

      const missingJaslin =
        Math.max(0, requiredJaslin - totalHoldingJaslin);

      const missingGram =
        missingJaslin * priceGram;

      if (totalHoldingJaslin < requiredJaslin) {
        return res.status(400).json({
          error: "Holding Power belum cukup.",
          currentLevel,
          targetLevel,
          gameBalance,
          walletBalance,
          totalHoldingJaslin,
          holdingPowerGram,
          requiredJaslin,
          requiredGram,
          missingJaslin,
          missingGram
        });
      }

      /* NAIK LEVEL TANPA POTONG SALDO */

      const { data: upgradedUser, error } =
        await supabase
          .from("users")
          .update({
            level: targetLevel
          })
          .eq(
            "telegram_id",
            String(req.tgUser.id)
          )
          .eq("level", currentLevel)
          .select("telegram_id")
          .maybeSingle();

      if (error) {
        throw error;
      }

      if (!upgradedUser) {
        return res.status(409).json({
          error: "Level sudah berubah. Muat ulang lalu coba lagi."
        });
      }

      await saveTransaction(
        req.tgUser.id,
        "upgrade_core",
        0,
        `Holding Power upgrade Level ${currentLevel} ke ${targetLevel}`
      );

      const updated =
        await getUser(req.tgUser.id);

      res.json({
        ...await publicState(updated),

        upgraded: true,
        previousLevel: currentLevel,
        newLevel: targetLevel,

        gameBalance,
        walletBalance,
        totalHoldingJaslin,

        priceGram,
        holdingPowerGram,
        requiredJaslin,
        requiredGram
      });

    } catch (error) {
      console.error(
        "Upgrade Core error:",
        safeErrorDetails(error)
      );

      res.status(500).json({
        error: "Upgrade Core gagal."
      });
    }
  }
);


/* =========================================
   USER ACTIVITY / TRANSACTION HISTORY
========================================= */

app.get(
  "/api/transactions",
  auth,
  async (req, res) => {
    try {
      const limit = Math.min(50, Math.max(1, Number(req.query?.limit || 20)));
      const { data, error } = await supabase
        .from("transactions")
        .select("type, amount, status, tx_signature, note, created_at")
        .eq("telegram_id", String(req.tgUser.id))
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) throw error;

      res.json({
        transactions: (data || []).map((row) => ({
          type: row.type || "activity",
          amount: Number(row.amount || 0),
          status: row.status || "completed",
          txSignature: row.tx_signature || "",
          note: row.note || "",
          createdAt: Number(row.created_at || 0)
        }))
      });
    } catch (error) {
      console.error("Transaction history error:", error);
      res.status(500).json({ error: "Gagal mengambil activity history." });
    }
  }
);

app.get(
  "/api/withdrawals",
  auth,
  async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("withdrawals")
        .select("request_id, wallet, amount, fee, receive_amount, status, query_id, error_message, created_at, updated_at")
        .eq("telegram_id", String(req.tgUser.id))
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) throw error;

      res.json({ withdrawals: data || [] });
    } catch (error) {
      console.error("Withdrawal history error:", error);
      res.status(500).json({ error: "Gagal mengambil withdrawal history." });
    }
  }
);

app.get(
  "/api/admin/withdrawals",
  treasuryAdminAuth,
  async (req, res) => {
    try {
      const status = String(req.query?.status || "").trim();
      let query = supabase
        .from("withdrawals")
        .select("request_id, telegram_id, wallet, amount, fee, receive_amount, status, query_id, error_message, created_at, updated_at")
        .order("created_at", { ascending: false })
        .limit(100);

      if (status) query = query.eq("status", status);
      const { data, error } = await query;
      if (error) throw error;
      res.json({ withdrawals: data || [] });
    } catch (error) {
      console.error("Admin withdrawal list error:", error);
      res.status(500).json({ error: "Gagal mengambil daftar withdrawal." });
    }
  }
);

/* =========================================
   REFERRAL NETWORK
========================================= */

app.get(
  "/api/referrals",
  auth,
  async (req, res) => {
    try {
      const ownerId = String(req.tgUser.id);
      const onlineThreshold = Date.now() - (2 * 60 * 1000);

      const { data, error } = await supabase
        .from("users")
        .select("telegram_id, username, first_name, created_at, last_seen_at")
        .eq("referred_by", ownerId)
        .order("created_at", { ascending: false });

      if (error) throw error;

      const referrals = (data || []).map((row) => ({
        id: row.telegram_id,
        username: row.username || "",
        firstName: row.first_name || "",
        joinedAt: Number(row.created_at || 0),
        lastSeenAt: Number(row.last_seen_at || 0),
        status:
          Number(row.last_seen_at || 0) >= onlineThreshold
            ? "online"
            : "offline"
      }));

      res.json({
        count: referrals.length,
        referrals
      });
    } catch (error) {
      console.error("Referral list error:", error);
      res.status(500).json({
        error: "Gagal mengambil daftar referral."
      });
    }
  }
);

app.post(
  "/api/referral-commission/claim",
  auth,
  maintenanceGuard,
  limitReferralClaim,
  async (req, res) => {
    try {
      const user = await getUser(req.tgUser.id);

      if (!user) {
        return res.status(404).json({
          error: "User tidak ditemukan."
        });
      }

      const commission = Number(user.referral_commission_balance || 0);

      if (commission <= 0) {
        return res.status(400).json({
          error: "Belum ada referral commission yang bisa diclaim."
        });
      }

      const currentBalance = Number(user.balance || 0);
      const newBalance = currentBalance + commission;

      const { data: claimedUser, error: claimError } = await supabase
        .from("users")
        .update({
          balance: newBalance,
          referral_commission_balance: 0
        })
        .eq("telegram_id", String(req.tgUser.id))
        .eq("balance", user.balance)
        .eq("referral_commission_balance", user.referral_commission_balance ?? 0)
        .select("telegram_id")
        .maybeSingle();

      if (claimError) throw claimError;

      if (!claimedUser) {
        return res.status(409).json({
          error: "Commission sedang berubah. Coba claim lagi."
        });
      }

      await saveTransaction(
        req.tgUser.id,
        "referral_commission_claim",
        commission,
        "Manual claim referral commission"
      );

      const updated = await getUser(req.tgUser.id);

      res.json({
        ...await publicState(updated),
        claimedReferralCommission: Number(commission.toFixed(8))
      });
    } catch (error) {
      console.error("Referral commission claim error:", error);
      res.status(500).json({
        error: error?.message || "Claim referral commission gagal."
      });
    }
  }
);


/* =========================================
   CORE PULSE
========================================= */

app.post(
  "/api/core-pulse",
  auth,
  maintenanceGuard,
  limitPulse,
  async (req, res) => {
    try {
      const user = await getUser(req.tgUser.id);

      if (!user) {
        return res.status(404).json({
          error: "User tidak ditemukan."
        });
      }

      const status = await getPulseStatus(user.telegram_id);

      if (status.pulseActive) {
        return res.status(409).json({
          error: "Core Pulse MAX sedang aktif.",
          ...status
        });
      }

      await saveTransaction(
        user.telegram_id,
        "core_pulse",
        0,
        `Core Pulse ${status.pulseLevel + 1}/3`
      );

      const updatedStatus =
        await getPulseStatus(user.telegram_id);

      const updatedState =
        await publicState(user);

      res.json({
        ...updatedState,
        ...updatedStatus,
        tapAccepted: true,
        activated: updatedStatus.pulseActive
      });

    } catch (error) {
      console.error("Core Pulse error:", error);
      res.status(500).json({
        error: "Core Pulse gagal diaktifkan."
      });
    }
  }
);


/* =========================================
   TON WALLET
========================================= */

app.post(
  "/api/wallet",
  auth,
  limitWallet,
  async (
    req,
    res
  ) => {

    try {

      const wallet =
        String(
          req.body?.wallet ||
          ""
        ).trim();

      if (wallet) {

        try {

          Address.parse(
            wallet
          );

        } catch {

          return res
            .status(400)
            .json({
              error:
                "Alamat wallet TON tidak valid."
            });

        }

      }

      const {
        error
      } =
        await supabase
          .from("users")
          .update({
            wallet:
              wallet
          })
          .eq(
            "telegram_id",
            String(
              req.tgUser.id
            )
          );

      if (error) {
        throw error;
      }

      res.json({
        wallet:
          wallet,
        network:
          "TON"
      });

    } catch (
      error
    ) {

      console.error(
        error
      );

      res
        .status(500)
        .json({
          error:
            "Gagal menyimpan wallet TON."
        });

    }

  }
);


/* =========================================
   WITHDRAW JASLIN
   Default OFF. Set WITHDRAWALS_ENABLED=true
   only after treasury testing.
========================================= */

function toJettonUnits(value) {
  const fixed = Number(value).toFixed(JASLIN_DECIMALS);
  const [whole, fraction = ""] = fixed.split(".");
  const padded = fraction.padEnd(JASLIN_DECIMALS, "0");
  return BigInt(whole) * (10n ** BigInt(JASLIN_DECIMALS)) +
    BigInt(padded || "0");
}

async function sendJaslinFromTreasury(destinationAddress, amount) {
  if (!TON_TREASURY_MNEMONIC || !TON_TREASURY_ADDRESS) {
    throw new Error("Treasury environment belum lengkap.");
  }

  const mnemonic =
    TON_TREASURY_MNEMONIC.trim().split(/\s+/);

  const keyPair =
    await mnemonicToPrivateKey(mnemonic);

  const expected =
    Address.parse(TON_TREASURY_ADDRESS);

  const walletV4 = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey
  });

  const walletV5 = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
    walletId: { networkGlobalId: -239 }
  });

  const expectedRaw = expected.toRawString();
  let walletContract;

  if (walletV4.address.toRawString() === expectedRaw) {
    walletContract = walletV4;
  } else if (walletV5.address.toRawString() === expectedRaw) {
    walletContract = walletV5;
  } else {
    throw new Error("Recovery phrase tidak cocok dengan treasury.");
  }

  const openedWallet = tonClient.open(walletContract);

  const jettonMaster = tonClient.open(
    JettonMaster.create(Address.parse(JASLIN_JETTON_MASTER))
  );

  const treasuryJettonWallet =
    await jettonMaster.getWalletAddress(expected);

  const destination = Address.parse(destinationAddress);
  const queryId = BigInt(Date.now());

  const transferBody = beginCell()
    .storeUint(0xf8a7ea5, 32)
    .storeUint(queryId, 64)
    .storeCoins(toJettonUnits(amount))
    .storeAddress(destination)
    .storeAddress(expected)
    .storeBit(0)
    .storeCoins(toNano("0.02"))
    .storeBit(0)
    .endCell();

  const seqnoBefore = await openedWallet.getSeqno();
  const sender = openedWallet.sender(keyPair.secretKey);

  await sender.send({
    to: treasuryJettonWallet,
    value: toNano("0.08"),
    body: transferBody
  });

  // Once sender.send() resolves we consider the transfer submitted.
  // Confirmation polling is best-effort only; a later RPC timeout must NOT
  // cause the game balance to be refunded automatically.
  let seqnoAdvanced = false;
  try {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1250));
      const seqnoNow = await openedWallet.getSeqno();
      if (seqnoNow > seqnoBefore) {
        seqnoAdvanced = true;
        break;
      }
    }
  } catch (confirmationError) {
    console.warn("Withdrawal confirmation polling warning:", confirmationError?.message || confirmationError);
  }

  return {
    submitted: true,
    seqnoAdvanced,
    queryId: queryId.toString(),
    destination: destination.toString({ bounceable: false, urlSafe: true })
  };
}

app.post(
  "/api/withdraw",
  auth,
  maintenanceGuard,
  limitWithdraw,
  async (req, res) => {
    let reserved = false;
    let chainSubmitted = false;
    let reservedAmount = 0;
    let requestId = "";

    const updateWithdrawal = async (patch) => {
      if (!requestId) return;
      const { error } = await supabase
        .from("withdrawals")
        .update({ ...patch, updated_at: Date.now() })
        .eq("request_id", requestId)
        .eq("telegram_id", String(req.tgUser.id));
      if (error) console.error("Withdrawal state update error:", error.message);
    };

    try {
      if (!WITHDRAWALS_ENABLED) {
        return res.status(503).json({
          error: "Withdrawal sedang dinonaktifkan untuk pengujian treasury."
        });
      }

      const user = await getUser(req.tgUser.id);
      if (!user) {
        return res.status(404).json({ error: "User tidak ditemukan." });
      }

      requestId = String(req.body?.requestId || "").trim();
      if (!/^[a-zA-Z0-9_-]{12,100}$/.test(requestId)) {
        return res.status(400).json({ error: "Withdrawal request ID tidak valid." });
      }

      const { data: existing, error: existingError } = await supabase
        .from("withdrawals")
        .select("request_id, amount, fee, receive_amount, status, query_id, wallet, created_at")
        .eq("request_id", requestId)
        .eq("telegram_id", String(user.telegram_id))
        .maybeSingle();
      if (existingError) throw existingError;

      if (existing) {
        return res.status(existing.status === "sent" ? 200 : 202).json({
          ...await publicState(user),
          idempotent: true,
          withdrawal: existing
        });
      }

      const amount = Math.floor(Number(req.body?.amount || 0));
      if (!Number.isFinite(amount) || amount < MIN_WITHDRAW_JASLIN) {
        return res.status(400).json({
          error: `Minimum withdrawal ${MIN_WITHDRAW_JASLIN.toLocaleString()} JASLIN.`
        });
      }

      if (!user.wallet) {
        return res.status(400).json({ error: "Connect TON Wallet terlebih dahulu." });
      }
      Address.parse(user.wallet);

      const currentBalance = Number(user.balance || 0);
      if (amount > currentBalance) {
        return res.status(400).json({ error: "Saldo game JASLIN tidak cukup." });
      }

      const receiveAmount = amount - WITHDRAW_FEE_JASLIN;
      if (receiveAmount <= 0) {
        return res.status(400).json({ error: "Jumlah withdrawal terlalu kecil setelah fee." });
      }

      const now = Date.now();
      const { error: insertError } = await supabase
        .from("withdrawals")
        .insert({
          request_id: requestId,
          telegram_id: String(user.telegram_id),
          wallet: user.wallet,
          amount,
          fee: WITHDRAW_FEE_JASLIN,
          receive_amount: receiveAmount,
          status: "pending",
          query_id: null,
          error_message: null,
          created_at: now,
          updated_at: now
        });
      if (insertError) throw insertError;

      const newBalance = currentBalance - amount;
      const { data: reservedUser, error: reserveError } = await supabase
        .from("users")
        .update({ balance: newBalance })
        .eq("telegram_id", String(user.telegram_id))
        .eq("balance", user.balance)
        .select("telegram_id")
        .maybeSingle();
      if (reserveError) throw reserveError;

      if (!reservedUser) {
        await updateWithdrawal({ status: "failed", error_message: "Balance changed before reserve" });
        return res.status(409).json({ error: "Saldo berubah. Coba withdrawal kembali." });
      }

      reserved = true;
      reservedAmount = amount;
      await updateWithdrawal({ status: "reserved" });

      await saveTransaction(
        user.telegram_id,
        "withdraw_pending",
        -amount,
        `Withdrawal ${requestId}: request ${amount} JASLIN; fee ${WITHDRAW_FEE_JASLIN}`,
        null,
        "pending"
      );

      const chain = await sendJaslinFromTreasury(user.wallet, receiveAmount);
      chainSubmitted = Boolean(chain?.submitted);

      await updateWithdrawal({
        status: "sent",
        query_id: chain.queryId,
        error_message: chain.seqnoAdvanced ? null : "Submitted; confirmation pending"
      });

      await saveTransaction(
        user.telegram_id,
        "withdraw_sent",
        receiveAmount,
        `Withdrawal ${requestId} submitted; fee ${WITHDRAW_FEE_JASLIN}; query ${chain.queryId}`,
        chain.queryId,
        "sent"
      );

      const updated = await getUser(user.telegram_id);
      return res.json({
        ...await publicState(updated),
        withdrawn: amount,
        fee: WITHDRAW_FEE_JASLIN,
        received: receiveAmount,
        destination: chain.destination,
        queryId: chain.queryId,
        withdrawalStatus: "sent",
        confirmationPending: !chain.seqnoAdvanced,
        requestId
      });

    } catch (error) {
      console.error("Withdrawal error:", safeErrorDetails(error));

      // Refund only when balance was reserved AND chain submission is known
      // not to have completed. Never auto-refund an already submitted transfer.
      if (reserved && !chainSubmitted) {
        try {
          await applyBalanceDelta(req.tgUser.id, reservedAmount);
          await updateWithdrawal({
            status: "refunded",
            error_message: error?.message || "Withdrawal failed before chain submission"
          });
          await saveTransaction(
            req.tgUser.id,
            "withdraw_refund",
            reservedAmount,
            `Withdrawal ${requestId} gagal sebelum submit; saldo dikembalikan`,
            null,
            "refunded"
          );
        } catch (refundError) {
          console.error("Withdrawal refund error:", safeErrorDetails(refundError));
          await updateWithdrawal({
            status: "failed",
            error_message: `Refund requires review: ${refundError?.message || refundError}`
          });
        }
      } else if (chainSubmitted) {
        await updateWithdrawal({
          status: "sent",
          error_message: `Submitted; server follow-up error: ${error?.message || error}`
        });
      } else {
        await updateWithdrawal({
          status: "failed",
          error_message: error?.message || "Withdrawal failed"
        });
      }

      return res.status(chainSubmitted ? 202 : 500).json({
        error: chainSubmitted
          ? "Withdrawal sudah disubmit ke jaringan dan sedang menunggu konfirmasi. Saldo tidak direfund otomatis."
          : (error?.message || "Withdrawal gagal."),
        requestId,
        submitted: chainSubmitted
      });
    }
  }
);

/* =========================================
   TREASURY CHECK
   TIDAK MENGIRIM TRANSAKSI
========================================= */

app.get(
  "/api/treasury-check",
  treasuryAdminAuth,
  async (
    req,
    res
  ) => {

    try {

      if (
        !TON_TREASURY_MNEMONIC
      ) {

        return res
          .status(500)
          .json({
            ok:
              false,
            error:
              "TON_TREASURY_MNEMONIC belum tersedia."
          });

      }

      if (
        !TON_TREASURY_ADDRESS
      ) {

        return res
          .status(500)
          .json({
            ok:
              false,
            error:
              "TON_TREASURY_ADDRESS belum tersedia."
          });

      }


      /* VALIDATE EXPECTED ADDRESS */

      const expected =
        Address.parse(
          TON_TREASURY_ADDRESS
        );

      const mnemonic =
        TON_TREASURY_MNEMONIC
          .trim()
          .split(/\s+/);


      if (
        mnemonic.length !== 12 &&
        mnemonic.length !== 24
      ) {

        return res
          .status(500)
          .json({
            ok:
              false,
            error:
              "Recovery phrase harus 12 atau 24 kata."
          });

      }


      /* DERIVE KEY */

      const keyPair =
        await mnemonicToPrivateKey(
          mnemonic
        );


      /* WALLET V4 */

      const walletV4 =
        WalletContractV4.create({
          workchain:
            0,
          publicKey:
            keyPair.publicKey
        });


      /* WALLET V5 MAINNET */

      const walletV5 =
        WalletContractV5R1.create({
          workchain:
            0,
          publicKey:
            keyPair.publicKey,
          walletId: {
            networkGlobalId:
              -239
          }
        });


      const expectedRaw =
        expected.toRawString();

      const v4Raw =
        walletV4.address
          .toRawString();

      const v5Raw =
        walletV5.address
          .toRawString();


      const v4Match =
        expectedRaw ===
        v4Raw;

      const v5Match =
        expectedRaw ===
        v5Raw;


      res.json({

        ok:
          true,

        network:
          TON_NETWORK,

        expectedAddress:
          expected.toString({
            bounceable:
              false,
            urlSafe:
              true
          }),

        walletV4:
          walletV4.address
            .toString({
              bounceable:
                false,
              urlSafe:
                true
            }),

        walletV5:
          walletV5.address
            .toString({
              bounceable:
                false,
              urlSafe:
                true
            }),

        v4Match:
          v4Match,

        v5Match:
          v5Match,

        matched:
          v4Match ||
          v5Match,

        walletVersion:
          v4Match
            ? "V4R2"
            : v5Match
              ? "V5R1"
              : "UNKNOWN",

        message:
          v4Match ||
          v5Match
            ? "Treasury cocok dengan recovery phrase."
            : "Alamat treasury belum cocok dengan V4/V5."

      });

    } catch (
      error
    ) {

      console.error(
        "Treasury check error:",
        error
      );

      res
        .status(500)
        .json({
          ok:
            false,
          error:
            "Treasury check gagal.",
          detail:
            error.message
        });

    }

  }
);


/* =========================================
   HEALTH CHECK
========================================= */

app.get(
  "/api/health",
  (
    req,
    res
  ) => {

    res.json({

      status:
        "ok",

      game:
        "JASLIN",

      database:
        "Supabase",

      network:
        "TON",

      jetton:
        JASLIN_JETTON_MASTER,

      decimals:
        JASLIN_DECIMALS,

      referralReward:
        REFERRAL_REWARD,

      referralCommissionRate:
        REFERRAL_COMMISSION_RATE,

      pulseTapWindowMs:
        PULSE_TAP_WINDOW_MS,

      pulseBoostDurationMs:
        PULSE_BOOST_DURATION_MS,

      pulseMaxMultiplier:
        PULSE_MAX_MULTIPLIER,

      maintenance:
        MAINTENANCE_MODE,

      withdrawalsEnabled:
        WITHDRAWALS_ENABLED,

      rateLimitMode:
        "instance-memory",

      fastLogin:
        true

    });

  }
);


/* =========================================
   START
========================================= */
app.get(
  "/api/treasury-balance",
  treasuryAdminAuth,
  async (req, res) => {
  try {
    const treasuryAddress = Address.parse(TON_TREASURY_ADDRESS);
    const jettonMasterAddress = Address.parse(JASLIN_JETTON_MASTER);

    const jettonMaster = tonClient.open(
      JettonMaster.create(jettonMasterAddress)
    );

    const jettonWalletAddress =
      await jettonMaster.getWalletAddress(treasuryAddress);

    const tonBalance = await tonClient.getBalance(treasuryAddress);

    let jaslinBalance = 0;

    try {
      const walletData = await tonClient.runMethod(
        jettonWalletAddress,
        "get_wallet_data"
      );

      const rawJettonBalance = BigInt(
        walletData.stack.items[0].value
      );

      jaslinBalance =
        Number(rawJettonBalance) /
        (10 ** JASLIN_DECIMALS);
    } catch (balanceError) {
      console.error(
        "Treasury JASLIN balance error:",
        balanceError
      );
    }

    res.json({
      ok: true,
      treasuryAddress: treasuryAddress.toString(),
      treasuryJettonWallet: jettonWalletAddress.toString(),
      tonBalanceNano: tonBalance.toString(),
      jaslinBalance
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || "Gagal membaca treasury"
    });
  }
});

app.listen(
  PORT,
  () => {

    if (!TREASURY_ADMIN_KEY) {
      console.warn(
        "TREASURY_ADMIN_KEY belum diset; endpoint treasury diagnostics akan terkunci."
      );
    }

    console.log(
      `JASLIN server running on port
${PORT}`
    );
  }
);
