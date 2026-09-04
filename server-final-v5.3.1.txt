import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
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

// V5 Auto Withdrawal uses a dedicated hot wallet. Keep the main treasury
// separate and never reuse its mnemonic for automatic payouts.
const JASLIN_HOT_WALLET_ADDRESS =
  String(process.env.JASLIN_HOT_WALLET_ADDRESS || "").trim();

const JASLIN_HOT_WALLET_MNEMONIC =
  String(process.env.JASLIN_HOT_WALLET_MNEMONIC || "").trim();

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
   X / TWITTER OAUTH + SOCIAL VERIFICATION
========================================= */

const X_CLIENT_ID = String(process.env.X_CLIENT_ID || "").trim();
const X_CLIENT_SECRET = String(process.env.X_CLIENT_SECRET || "").trim();
const X_CALLBACK_URL = String(process.env.X_CALLBACK_URL || "").trim();
const X_ACCOUNT_USERNAME = String(process.env.X_ACCOUNT_USERNAME || "").replace(/^@/, "").trim();
const X_TOKEN_ENCRYPTION_KEY = String(process.env.X_TOKEN_ENCRYPTION_KEY || "").trim();
const X_LIKE_POST_ID = String(process.env.X_LIKE_POST_ID || "").trim();
const X_REPOST_POST_ID = String(process.env.X_REPOST_POST_ID || "").trim();
const X_COMMENT_POST_ID = String(process.env.X_COMMENT_POST_ID || "").trim();
const X_SOCIAL_REWARD_JASLIN = 500;

const X_OAUTH_SCOPES = [
  "tweet.read",
  "users.read",
  "follows.read",
  "like.read",
  "offline.access"
];

const X_API_BASE = "https://api.x.com/2";
const X_OAUTH_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const X_OAUTH_TOKEN_URL = "https://api.x.com/2/oauth2/token";

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

const AUTO_WITHDRAW_DAILY_CAP_JASLIN = Math.max(0, Number(
  process.env.AUTO_WITHDRAW_DAILY_CAP_JASLIN || 20000
));
const WITHDRAW_COOLDOWN_HOURS = Math.max(0, Number(
  process.env.WITHDRAW_COOLDOWN_HOURS || 24
));
const HOT_WALLET_MIN_GRAM = Math.max(0.05, Number(
  process.env.HOT_WALLET_MIN_GRAM || 0.15
));

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

const JASLIN_POOL_ADDRESS =
  "EQBtaODtADXS7R6KJClA_-uOQlFkXG8_GCjjVfk4vUbMImxb";

const POOL_CACHE_TTL_MS = 30000;
const WALLET_BALANCE_CACHE_TTL_MS = 15000;
const GRAM_USD_CACHE_TTL_MS = 60000;
const REFERRAL_COUNT_CACHE_TTL_MS = 30000;

let poolSnapshotCache = {
  at: 0,
  data: null,
  promise: null
};

let gramUsdCache = {
  at: 0,
  value: 0,
  promise: null
};

const walletBalanceCache = new Map();
const referralCountCache = new Map();

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
   LIGHTWEIGHT RPC / COUNT CACHE
   Per serverless instance. Used only to reduce duplicate reads.
========================================= */

async function getPoolSnapshotCached(force = false) {
  const now = Date.now();

  if (
    !force &&
    poolSnapshotCache.data &&
    now - poolSnapshotCache.at < POOL_CACHE_TTL_MS
  ) {
    return poolSnapshotCache.data;
  }

  if (!force && poolSnapshotCache.promise) {
    return poolSnapshotCache.promise;
  }

  const promise = (async () => {
    const poolResult =
      await tonClient.runMethod(
        Address.parse(JASLIN_POOL_ADDRESS),
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

    if (
      !Number.isFinite(gramReserve) ||
      !Number.isFinite(jaslinReserve) ||
      gramReserve <= 0 ||
      jaslinReserve <= 0
    ) {
      throw new Error(
        "Pool reserve tidak valid."
      );
    }

    const data = {
      gramReserve,
      jaslinReserve,
      priceGram:
        gramReserve / jaslinReserve,
      jaslinPerGram:
        jaslinReserve / gramReserve
    };

    poolSnapshotCache = {
      at: Date.now(),
      data,
      promise: null
    };

    return data;
  })();

  poolSnapshotCache.promise =
    promise;

  try {
    return await promise;
  } catch (error) {
    if (poolSnapshotCache.data) {
      return poolSnapshotCache.data;
    }
    throw error;
  } finally {
    if (
      poolSnapshotCache.promise ===
      promise
    ) {
      poolSnapshotCache.promise = null;
    }
  }
}


async function getGramUsdCached(force = false) {
  const now = Date.now();

  if (
    !force &&
    gramUsdCache.value > 0 &&
    now - gramUsdCache.at < GRAM_USD_CACHE_TTL_MS
  ) {
    return gramUsdCache.value;
  }

  if (!force && gramUsdCache.promise) {
    return gramUsdCache.promise;
  }

  const promise = (async () => {
    const response =
      await fetch(
        "https://api.coingecko.com/api/v3/simple/price?names=Gram%20%28prev.%20Toncoin%29&vs_currencies=usd"
      );

    if (!response.ok) {
      throw new Error(
        "Gagal mengambil harga GRAM/USD"
      );
    }

    const data =
      await response.json();

    const value =
      Number(
        data?.["Gram (prev. Toncoin)"]?.usd ||
        0
      );

    if (
      !Number.isFinite(value) ||
      value <= 0
    ) {
      throw new Error(
        "Harga GRAM/USD tidak valid."
      );
    }

    gramUsdCache = {
      at: Date.now(),
      value,
      promise: null
    };

    return value;
  })();

  gramUsdCache.promise =
    promise;

  try {
    return await promise;
  } catch (error) {
    if (gramUsdCache.value > 0) {
      return gramUsdCache.value;
    }
    throw error;
  } finally {
    if (
      gramUsdCache.promise ===
      promise
    ) {
      gramUsdCache.promise = null;
    }
  }
}


async function getWalletJaslinBalanceCached(
  ownerAddress,
  force = false
) {
  const key =
    String(ownerAddress || "").trim();

  if (!key) {
    return 0;
  }

  const now = Date.now();
  const cached =
    walletBalanceCache.get(key);

  if (
    !force &&
    cached?.value !== undefined &&
    now - cached.at < WALLET_BALANCE_CACHE_TTL_MS
  ) {
    return Number(cached.value || 0);
  }

  if (!force && cached?.promise) {
    return cached.promise;
  }

  const promise = (async () => {
    try {
      const owner =
        Address.parse(key);

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
          owner
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

      const value =
        Number(rawBalance) /
        (10 ** JASLIN_DECIMALS);

      walletBalanceCache.set(
        key,
        {
          at: Date.now(),
          value,
          promise: null
        }
      );

      return value;

    } catch (error) {
      // Jetton wallet belum deployed / belum pernah menerima JASLIN = 0.
      if (
        String(error?.message || "")
          .includes("exit_code: -13")
      ) {
        walletBalanceCache.set(
          key,
          {
            at: Date.now(),
            value: 0,
            promise: null
          }
        );
        return 0;
      }

      if (cached?.value !== undefined) {
        return Number(cached.value || 0);
      }

      throw error;
    }
  })();

  walletBalanceCache.set(
    key,
    {
      at: cached?.at || 0,
      value: cached?.value,
      promise
    }
  );

  try {
    return await promise;
  } finally {
    const current =
      walletBalanceCache.get(key);

    if (current?.promise === promise) {
      walletBalanceCache.set(
        key,
        {
          at: current.at || 0,
          value: current.value,
          promise: null
        }
      );
    }
  }
}


async function getReferralCountCached(
  telegramId,
  force = false
) {
  const key =
    String(telegramId);

  const now = Date.now();
  const cached =
    referralCountCache.get(key);

  if (
    !force &&
    cached &&
    now - cached.at < REFERRAL_COUNT_CACHE_TTL_MS
  ) {
    return Number(cached.value || 0);
  }

  const { count, error } =
    await supabase
      .from("users")
      .select(
        "telegram_id",
        {
          count: "exact",
          head: true
        }
      )
      .eq(
        "referred_by",
        key
      );

  if (error) {
    throw error;
  }

  const value =
    Number(count || 0);

  referralCountCache.set(
    key,
    {
      at: Date.now(),
      value
    }
  );

  return value;
}


function invalidateReferralCount(
  telegramId
) {
  if (telegramId !== null &&
      telegramId !== undefined) {
    referralCountCache.delete(
      String(telegramId)
    );
  }
}


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
const limitXVerify = createRateLimit({ windowMs: 60_000, max: 6, prefix: "xverify" });
const limitXConnect = createRateLimit({ windowMs: 60_000, max: 6, prefix: "xconnect" });

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

  // start_param is part of Telegram's signed initData. Keep a trusted copy
  // server-side so referral attribution does not rely only on frontend JSON.
  try{
    req.tgStartParam =
      String(new URLSearchParams(initData).get("start_param") || "").trim();
  }catch{
    req.tgStartParam = "";
  }

  next();
}




/* =========================================
   X OAUTH HELPERS
========================================= */

function xConfigReady() {
  return Boolean(
    X_CLIENT_ID &&
    X_CLIENT_SECRET &&
    X_CALLBACK_URL &&
    X_ACCOUNT_USERNAME &&
    X_TOKEN_ENCRYPTION_KEY &&
    X_LIKE_POST_ID &&
    X_REPOST_POST_ID &&
    X_COMMENT_POST_ID
  );
}

function xUserDbId(telegramId) {
  // jaslin_x_* tables use UUID user_id. Existing JASLIN users are keyed by
  // telegram_id, so we derive a stable UUID without changing the users table.
  const hex = crypto
    .createHash("sha256")
    .update(`jaslin:x:${String(telegramId)}`)
    .digest("hex")
    .slice(0, 32)
    .split("");

  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function xEncryptionKeyBuffer() {
  if (/^[0-9a-fA-F]{64}$/.test(X_TOKEN_ENCRYPTION_KEY)) {
    return Buffer.from(X_TOKEN_ENCRYPTION_KEY, "hex");
  }

  // Backward-compatible fallback for a non-hex secret.
  return crypto.createHash("sha256").update(X_TOKEN_ENCRYPTION_KEY).digest();
}

function encryptXToken(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", xEncryptionKeyBuffer(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptXToken(value) {
  if (!value) return "";
  const [ivText, tagText, encryptedText] = String(value).split(".");
  if (!ivText || !tagText || !encryptedText) {
    throw new Error("Format token X terenkripsi tidak valid.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    xEncryptionKeyBuffer(),
    Buffer.from(ivText, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function xPkceChallenge(verifier) {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

function xBasicAuthHeader() {
  return `Basic ${Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString("base64")}`;
}

async function xTokenRequest(params) {
  const response = await fetch(X_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "authorization": xBasicAuthHeader()
    },
    body: new URLSearchParams(params)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error_description || data?.detail || data?.error || "X OAuth token request gagal.");
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

async function xApi(accessToken, pathName) {
  const response = await fetch(`${X_API_BASE}${pathName}`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json"
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      data?.detail || data?.title || data?.error || `X API gagal (${response.status}).`
    );
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

async function getXAccountByTelegramId(telegramId) {
  const { data, error } = await supabase
    .from("jaslin_x_accounts")
    .select("*")
    .eq("user_id", xUserDbId(telegramId))
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function refreshXAccessToken(account) {
  if (!account?.refresh_token_encrypted) return account;

  const expiresAt = account?.token_expires_at
    ? new Date(account.token_expires_at).getTime()
    : 0;

  if (expiresAt && expiresAt > Date.now() + 60_000) {
    return account;
  }

  const refreshToken = decryptXToken(account.refresh_token_encrypted);
  const tokenData = await xTokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: X_CLIENT_ID
  });

  const updated = {
    access_token_encrypted: encryptXToken(tokenData.access_token),
    refresh_token_encrypted: encryptXToken(tokenData.refresh_token || refreshToken),
    token_expires_at: tokenData.expires_in
      ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
      : null,
    scopes: String(tokenData.scope || "").split(/\s+/).filter(Boolean),
    connected: true,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from("jaslin_x_accounts")
    .update(updated)
    .eq("id", account.id)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function xFollowingHasUsername(accessToken, xUserId, username) {
  let token = "";
  for (let page = 0; page < 5; page += 1) {
    const qs = new URLSearchParams({
      max_results: "1000",
      "user.fields": "username"
    });
    if (token) qs.set("pagination_token", token);

    const data = await xApi(accessToken, `/users/${encodeURIComponent(xUserId)}/following?${qs}`);
    const found = (data?.data || []).some(
      (u) => String(u?.username || "").toLowerCase() === String(username).toLowerCase()
    );
    if (found) return true;

    token = data?.meta?.next_token || "";
    if (!token) break;
  }
  return false;
}

async function xLikedPost(accessToken, xUserId, postId) {
  if (!postId) return false;
  let token = "";
  for (let page = 0; page < 5; page += 1) {
    const qs = new URLSearchParams({ max_results: "100" });
    if (token) qs.set("pagination_token", token);
    const data = await xApi(accessToken, `/users/${encodeURIComponent(xUserId)}/liked_tweets?${qs}`);
    if ((data?.data || []).some((tweet) => String(tweet?.id) === String(postId))) return true;
    token = data?.meta?.next_token || "";
    if (!token) break;
  }
  return false;
}

async function xRepostedPost(accessToken, xUserId, postId) {
  if (!postId) return false;
  let token = "";
  for (let page = 0; page < 5; page += 1) {
    const qs = new URLSearchParams({ max_results: "1000" });
    if (token) qs.set("pagination_token", token);
    const data = await xApi(accessToken, `/tweets/${encodeURIComponent(postId)}/retweeted_by?${qs}`);
    if ((data?.data || []).some((user) => String(user?.id) === String(xUserId))) return true;
    token = data?.meta?.next_token || "";
    if (!token) break;
  }
  return false;
}

async function xCommentedOnPost(accessToken, username, postId) {
  if (!postId || !username) return false;
  const query = `conversation_id:${postId} from:${username} -is:retweet`;
  const qs = new URLSearchParams({
    query,
    max_results: "100",
    "tweet.fields": "conversation_id,author_id,in_reply_to_user_id"
  });
  const data = await xApi(accessToken, `/tweets/search/recent?${qs}`);
  return (data?.data || []).some(
    (tweet) => String(tweet?.conversation_id || "") === String(postId) && String(tweet?.id || "") !== String(postId)
  );
}

async function saveXVerificationLog(telegramId, type, success, responseCode = 200, responseData = {}) {
  try {
    await supabase.from("jaslin_x_verification_logs").insert({
      user_id: xUserDbId(telegramId),
      verification_type: type,
      success: Boolean(success),
      response_code: Number(responseCode || 0),
      response_data: responseData
    });
  } catch (error) {
    console.error("X verification log error:", safeErrorDetails(error));
  }
}

async function saveXBundleProgress(telegramId, verification) {
  // The SQL already installed earlier allows follow/like/repost task types only.
  // We store the complete Follow+Like+Repost+Comment result in one progress row
  // so Comment works without requiring a destructive schema migration.
  const { data: task, error: taskError } = await supabase
    .from("jaslin_social_tasks")
    .select("id,reward")
    .eq("task_key", "x_follow_jaslin")
    .maybeSingle();

  if (taskError || !task?.id) {
    if (taskError) console.error("X social task lookup error:", safeErrorDetails(taskError));
    return;
  }

  const allVerified = Boolean(
    verification.follow &&
    verification.like &&
    verification.repost &&
    verification.comment
  );

  const payload = {
    user_id: xUserDbId(telegramId),
    task_id: task.id,
    verified: allVerified,
    verified_at: allVerified ? new Date().toISOString() : null,
    verification_result: verification,
    reward_amount: Number(task.reward || 0),
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("jaslin_social_task_progress")
    .upsert(payload, { onConflict: "user_id,task_id" });

  if (error) {
    console.error("X progress save error:", safeErrorDetails(error));
  }
}

async function getXBundleProgress(telegramId) {
  const empty = {
    follow: false,
    like: false,
    repost: false,
    comment: false,
    allVerified: false,
    claimed: false,
    reward: X_SOCIAL_REWARD_JASLIN,
    claimedAt: null
  };

  const { data: task, error: taskError } = await supabase
    .from("jaslin_social_tasks")
    .select("id,reward")
    .eq("task_key", "x_follow_jaslin")
    .maybeSingle();

  if (taskError) throw taskError;
  if (!task?.id) return empty;

  const { data: progress, error: progressError } = await supabase
    .from("jaslin_social_task_progress")
    .select("verified,verification_result,claim_status,claimed_at,reward_amount")
    .eq("user_id", xUserDbId(telegramId))
    .eq("task_id", task.id)
    .maybeSingle();

  if (progressError) throw progressError;
  if (!progress) {
    return {
      ...empty,
      reward: Number(task.reward || X_SOCIAL_REWARD_JASLIN)
    };
  }

  const v = progress.verification_result || {};
  return {
    follow: Boolean(v.follow),
    like: Boolean(v.like),
    repost: Boolean(v.repost),
    comment: Boolean(v.comment),
    allVerified: Boolean(progress.verified),
    claimed: progress.claim_status === "claimed",
    reward: Number(progress.reward_amount || task.reward || X_SOCIAL_REWARD_JASLIN),
    claimedAt: progress.claimed_at || null
  };
}

/* =========================================
   X OAUTH ROUTES
========================================= */

app.get("/api/x/connect", auth, limitXConnect, async (req, res) => {
  try {
    if (!xConfigReady()) {
      return res.status(503).json({
        ok: false,
        error: "Konfigurasi X API belum lengkap di Vercel."
      });
    }

    const state = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(48).toString("base64url");
    const userId = xUserDbId(req.tgUser.id);

    const { error } = await supabase
      .from("jaslin_x_oauth_states")
      .insert({
        user_id: userId,
        state,
        code_verifier: verifier,
        redirect_uri: X_CALLBACK_URL,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
      });

    if (error) throw error;

    const params = new URLSearchParams({
      response_type: "code",
      client_id: X_CLIENT_ID,
      redirect_uri: X_CALLBACK_URL,
      scope: X_OAUTH_SCOPES.join(" "),
      state,
      code_challenge: xPkceChallenge(verifier),
      code_challenge_method: "S256"
    });

    return res.json({
      ok: true,
      authorizationUrl: `${X_OAUTH_AUTHORIZE_URL}?${params.toString()}`
    });
  } catch (error) {
    console.error("X connect error:", safeErrorDetails(error));
    return res.status(500).json({ ok: false, error: "Gagal memulai koneksi X." });
  }
});

app.get("/api/x/callback", async (req, res) => {
  const code = String(req.query?.code || "");
  const state = String(req.query?.state || "");
  const oauthError = String(req.query?.error || "");

  try {
    if (oauthError) {
      return res.status(400).send("X authorization dibatalkan atau ditolak.");
    }
    if (!code || !state) {
      return res.status(400).send("Callback X tidak valid.");
    }

    const { data: oauthState, error: stateError } = await supabase
      .from("jaslin_x_oauth_states")
      .select("*")
      .eq("state", state)
      .maybeSingle();

    if (stateError) throw stateError;
    if (!oauthState) return res.status(400).send("State X tidak ditemukan atau sudah digunakan.");
    if (new Date(oauthState.expires_at).getTime() < Date.now()) {
      await supabase.from("jaslin_x_oauth_states").delete().eq("id", oauthState.id);
      return res.status(400).send("Sesi Connect X sudah kedaluwarsa. Silakan ulangi.");
    }

    const tokenData = await xTokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: X_CALLBACK_URL,
      code_verifier: oauthState.code_verifier,
      client_id: X_CLIENT_ID
    });

    const me = await xApi(tokenData.access_token, "/users/me?user.fields=username,name");
    if (!me?.data?.id) throw new Error("Profil akun X tidak ditemukan.");

    const accountPayload = {
      user_id: oauthState.user_id,
      x_user_id: String(me.data.id),
      x_username: me.data.username || "",
      x_name: me.data.name || "",
      access_token_encrypted: encryptXToken(tokenData.access_token),
      refresh_token_encrypted: tokenData.refresh_token ? encryptXToken(tokenData.refresh_token) : null,
      token_expires_at: tokenData.expires_in
        ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
        : null,
      scopes: String(tokenData.scope || "").split(/\s+/).filter(Boolean),
      connected: true,
      updated_at: new Date().toISOString()
    };

    const { error: accountError } = await supabase
      .from("jaslin_x_accounts")
      .upsert(accountPayload, { onConflict: "user_id" });

    if (accountError) throw accountError;

    await supabase.from("jaslin_x_oauth_states").delete().eq("id", oauthState.id);

    // Return to the Telegram Mini App so Telegram initData is available again.
    // The frontend reads start_param=x_connected and refreshes X status.
    const botName = String(BOT_USERNAME || "JaslinEarnBot").replace(/^@/, "").trim();
    const returnUrl = `https://t.me/${encodeURIComponent(botName)}?startapp=x_connected`;

    return res.redirect(302, returnUrl);
  } catch (error) {
    console.error("X callback error:", safeErrorDetails(error));
    return res.status(500).send("Connect X gagal. Periksa konfigurasi X Developer dan Vercel.");
  }
});

app.get("/api/x/status", auth, async (req, res) => {
  try {
    const [account, progress] = await Promise.all([
      getXAccountByTelegramId(req.tgUser.id),
      getXBundleProgress(req.tgUser.id)
    ]);

    return res.json({
      connected: Boolean(account?.connected),
      username: account?.x_username || "",
      name: account?.x_name || "",
      verification: {
        follow: progress.follow,
        like: progress.like,
        repost: progress.repost,
        comment: progress.comment,
        allVerified: progress.allVerified
      },
      claimed: progress.claimed,
      claimedAt: progress.claimedAt,
      reward: progress.reward
    });
  } catch (error) {
    console.error("X status error:", safeErrorDetails(error));
    return res.status(500).json({ error: "Gagal membaca status akun X." });
  }
});

app.post("/api/x/disconnect", auth, async (req, res) => {
  try {
    const { error } = await supabase
      .from("jaslin_x_accounts")
      .delete()
      .eq("user_id", xUserDbId(req.tgUser.id));
    if (error) throw error;
    return res.json({ ok: true, connected: false });
  } catch (error) {
    console.error("X disconnect error:", safeErrorDetails(error));
    return res.status(500).json({ ok: false, error: "Gagal memutus akun X." });
  }
});

/* =========================================
   X SOCIAL TASK VERIFICATION
========================================= */

app.post("/api/social-tasks/verify", auth, limitXVerify, async (req, res) => {
  try {
    if (!xConfigReady()) {
      return res.status(503).json({ error: "Konfigurasi X API belum lengkap." });
    }

    let account = await getXAccountByTelegramId(req.tgUser.id);
    if (!account?.connected) {
      return res.status(400).json({
        connected: false,
        error: "Hubungkan akun X terlebih dahulu."
      });
    }

    account = await refreshXAccessToken(account);
    const accessToken = decryptXToken(account.access_token_encrypted);

    const verification = {
      follow: false,
      like: false,
      repost: false,
      comment: false,
      checkedAt: new Date().toISOString(),
      targetUsername: X_ACCOUNT_USERNAME,
      postId: X_LIKE_POST_ID || X_REPOST_POST_ID || X_COMMENT_POST_ID
    };

    const errors = {};

    const checks = [
      ["follow", () => xFollowingHasUsername(accessToken, account.x_user_id, X_ACCOUNT_USERNAME)],
      ["like", () => xLikedPost(accessToken, account.x_user_id, X_LIKE_POST_ID)],
      ["repost", () => xRepostedPost(accessToken, account.x_user_id, X_REPOST_POST_ID)],
      ["comment", () => xCommentedOnPost(accessToken, account.x_username, X_COMMENT_POST_ID)]
    ];

    for (const [key, fn] of checks) {
      try {
        verification[key] = Boolean(await fn());
        await saveXVerificationLog(req.tgUser.id, key, verification[key], 200, {
          postId: key === "follow" ? null : (
            key === "like" ? X_LIKE_POST_ID : key === "repost" ? X_REPOST_POST_ID : X_COMMENT_POST_ID
          )
        });
      } catch (error) {
        errors[key] = {
          status: error?.status || 500,
          message: error?.message || "X API verification gagal."
        };
        await saveXVerificationLog(req.tgUser.id, key, false, error?.status || 500, errors[key]);
      }
    }

    verification.allVerified = Boolean(
      verification.follow &&
      verification.like &&
      verification.repost &&
      verification.comment
    );

    await saveXBundleProgress(req.tgUser.id, verification);
    const progress = await getXBundleProgress(req.tgUser.id);

    return res.json({
      connected: true,
      xUsername: account.x_username,
      verification,
      claimed: progress.claimed,
      reward: progress.reward,
      errors,
      note: Object.keys(errors).length
        ? "Sebagian endpoint X API gagal. Periksa akses/credit X Developer untuk endpoint terkait."
        : undefined
    });
  } catch (error) {
    console.error("X social verify error:", safeErrorDetails(error));
    return res.status(500).json({
      error: error?.message || "Verifikasi social task X gagal."
    });
  }
});

/* =========================================
   X SOCIAL REWARD CLAIM - 500 JASLIN
   Atomic claim is executed by Supabase RPC claim_x_social_reward().
========================================= */

app.post(
  "/api/social-tasks/claim-x",
  auth,
  maintenanceGuard,
  limitClaim,
  async (req, res) => {
    try {
      const telegramId = String(req.tgUser.id);

      const { data, error } = await supabase.rpc("claim_x_social_reward", {
        p_telegram_id: telegramId,
        p_x_user_id: xUserDbId(telegramId)
      });

      if (error) {
        const msg = String(error?.message || "");
        if (msg.includes("X_MISSIONS_NOT_VERIFIED")) {
          return res.status(400).json({
            error: "Follow, Like, Repost, dan Comment harus terverifikasi sebelum claim."
          });
        }
        if (msg.includes("JASLIN_USER_NOT_FOUND")) {
          return res.status(404).json({ error: "User JASLIN tidak ditemukan." });
        }
        if (msg.includes("claim_x_social_reward")) {
          return res.status(503).json({
            error: "SQL reward X belum terpasang di Supabase. Jalankan jaslin-x-reward-final.sql."
          });
        }
        throw error;
      }

      const result = data || {};

      // Transaction history is best-effort only. The balance + claim lock
      // itself is atomic inside the database RPC.
      if (result.claimed && !result.alreadyClaimed) {
        await saveTransaction(
          telegramId,
          "x_social_reward",
          Number(result.reward || X_SOCIAL_REWARD_JASLIN),
          "X Social Missions: Follow + Like + Repost + Comment"
        );
      }

      const updated = await getUser(telegramId);

      return res.json({
        ok: true,
        claimed: Boolean(result.claimed || result.alreadyClaimed),
        alreadyClaimed: Boolean(result.alreadyClaimed),
        reward: Number(result.reward || X_SOCIAL_REWARD_JASLIN),
        balance: Number(result.balance ?? updated?.balance ?? 0),
        state: updated ? await publicState(updated) : null
      });
    } catch (error) {
      console.error("X social reward claim error:", safeErrorDetails(error));
      return res.status(500).json({
        error: error?.message || "Claim reward X gagal."
      });
    }
  }
);

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

    let resolvedUser = updatedUser || user;

    // Telegram can occasionally create/open the Mini App once before a referral
    // launch parameter is available to the first session request. Allow a short,
    // one-time grace window to attach an otherwise-unreferred NEW account.
    // This is conditional on referred_by still being NULL, so no referrer can
    // overwrite an existing attribution and the reward cannot be paid twice.
    if (
      referralCode &&
      referralCode !== telegramId &&
      !resolvedUser?.referred_by
    ) {
      const createdAt = Number(resolvedUser?.created_at || 0);
      const referralGraceMs = 30 * 60 * 1000;

      if (createdAt > 0 && Date.now() - createdAt <= referralGraceMs) {
        const referrer = await getUser(referralCode);

        if (referrer) {
          const { data: boundUser, error: bindError } = await supabase
            .from("users")
            .update({ referred_by: referralCode })
            .eq("telegram_id", telegramId)
            .is("referred_by", null)
            .select("*")
            .maybeSingle();

          if (bindError) throw bindError;

          if (boundUser) {
            resolvedUser = boundUser;

            await applyBalanceDelta(
              referralCode,
              REFERRAL_REWARD
            );

            await saveTransaction(
              referralCode,
              "referral",
              REFERRAL_REWARD,
              `Referral dari ${telegramId}`
            );

            invalidateReferralCount(
              referralCode
            );
          }
        }
      }
    }

    return resolvedUser;
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

      invalidateReferralCount(
        referredBy
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
    referralCount =
      await getReferralCountCached(
        user.telegram_id
      );
  } catch (error) {
    console.error(
      "Referral count error:",
      error?.message || error
    );
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
    withdrawalMode: "auto",
    minimumWithdraw: MIN_WITHDRAW_JASLIN,
    withdrawFee: WITHDRAW_FEE_JASLIN,
    withdrawalCooldownHours: WITHDRAW_COOLDOWN_HOURS,
    autoWithdrawDailyCap: AUTO_WITHDRAW_DAILY_CAP_JASLIN,
    nativeGasCoin: "GRAM",
    hotWalletMinGram: HOT_WALLET_MIN_GRAM
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
          req.tgStartParam ||
          req.body?.startParam ||
          ""
        ).trim();

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

      // Main balance mutation remains concurrency-protected.
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
          .select("telegram_id,balance,mining_started_at")
          .maybeSingle();

      if (claimError) throw claimError;

      if (!claimedUser) {
        return res.status(409).json({
          error: "Claim sedang diproses atau saldo berubah. Coba lagi."
        });
      }

      // History and referral work are kept server-side. Run independent work
      // in parallel so the claim response is not delayed more than necessary.
      const sideEffects = [];

      sideEffects.push(
        saveTransaction(
          req.tgUser.id,
          "mining",
          claimed,
          "Mining claim"
        )
      );

      let referralCommission = 0;
      if (user.referred_by) {
        referralCommission = Number(
          (claimed * REFERRAL_COMMISSION_RATE).toFixed(8)
        );

        if (referralCommission > 0) {
          sideEffects.push((async () => {
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
          })());
        }
      }

      const sideEffectResults = await Promise.allSettled(sideEffects);
      for (const result of sideEffectResults) {
        if (result.status === "rejected") {
          console.error("Claim side-effect error:", safeErrorDetails(result.reason));
        }
      }

      return res.json({
        ok: true,
        claimed: Number(claimed.toFixed(4)),
        balance: Number(Number(claimedUser.balance ?? newBalance).toFixed(4)),
        mining: 0,
        miningStartedAt: Number(claimedUser.mining_started_at || now),
        miningCapAt: Number(claimedUser.mining_started_at || now) + 8 * 60 * 60 * 1000,
        referralCommissionPaid: referralCommission
      });

    } catch (error) {
      console.error("Claim mining error:", safeErrorDetails(error));

      return res.status(500).json({
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
    const [
      pool,
      gramPriceUsd
    ] = await Promise.all([
      getPoolSnapshotCached(),
      getGramUsdCached()
    ]);

    const priceUsd =
      pool.priceGram *
      gramPriceUsd;

    res.json({
      ok: true,
      symbol: "JASLIN",
      pair: "JASLIN/GRAM",
      source: "dedust_onchain",

      jaslinReserve:
        pool.jaslinReserve,

      gramReserve:
        pool.gramReserve,

      priceGram:
        pool.priceGram,

      jaslinPerGram:
        pool.jaslinPerGram,

      gramPriceUsd,
      priceUsd,

      updatedAt: Date.now()
    });

  } catch (error) {
    console.error(
      "JASLIN pool error:",
      safeErrorDetails(error)
    );

    res.status(500).json({
      ok: false,
      error:
        error?.message ||
        String(error)
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

      const walletPromise =
        user.wallet
          ? getWalletJaslinBalanceCached(
              user.wallet
            ).catch((error) => {
              console.error(
                "Level quote wallet error:",
                safeErrorDetails(error)
              );
              return 0;
            })
          : Promise.resolve(0);

      const poolPromise =
        getPoolSnapshotCached()
          .catch((error) => {
            console.error(
              "Level quote pool error:",
              safeErrorDetails(error)
            );
            return null;
          });

      const [
        walletBalance,
        pool
      ] = await Promise.all([
        walletPromise,
        poolPromise
      ]);

      const totalHoldingJaslin =
        gameBalance +
        Number(walletBalance || 0);

      const priceGram =
        Number(
          pool?.priceGram ||
          0
        );

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
          // Upgrade memakai fresh on-chain balance agar eligibility tidak
          // bergantung pada cache UI.
          walletBalance =
            await getWalletJaslinBalanceCached(
              user.wallet,
              true
            );
        } catch (error) {
          console.error(
            "JASLIN wallet balance error:",
            safeErrorDetails(error)
          );

          return res.status(503).json({
            error:
              "Holding wallet belum bisa diverifikasi. Coba lagi sebentar."
          });
        }
      }

      /* TOTAL HOLDING */

      const totalHoldingJaslin =
        gameBalance + walletBalance;

      const requiredJaslin =
        requiredHoldingJaslin(targetLevel);

      const missingJaslin =
        Math.max(
          0,
          requiredJaslin - totalHoldingJaslin
        );

      // Harga GRAM bukan syarat upgrade. Ambil dari cache hanya untuk display.
      let priceGram = 0;

      try {
        priceGram =
          Number(
            (await getPoolSnapshotCached())
              ?.priceGram ||
            0
          );
      } catch (error) {
        console.error(
          "Upgrade pool quote error:",
          safeErrorDetails(error)
        );
      }

      /* HOLDING POWER */

      const holdingPowerGram =
        totalHoldingJaslin * priceGram;

      const requiredGram =
        requiredJaslin * priceGram;

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
   PRESENCE HEARTBEAT
========================================= */

app.post(
  "/api/presence/ping",
  auth,
  async (req, res) => {
    try {
      const now = Date.now();
      const { error } = await supabase
        .from("users")
        .update({ last_seen_at: now })
        .eq("telegram_id", String(req.tgUser.id));

      if (error) throw error;

      res.json({ ok: true, lastSeenAt: now });
    } catch (error) {
      console.error("Presence ping error:", error);
      res.status(500).json({ error: "Gagal memperbarui status aktivitas." });
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
      const onlineThreshold = Date.now() - (90 * 1000);

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
            : "offline",
        isActive:
          Number(row.last_seen_at || 0) >= onlineThreshold
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
      const telegramId = String(req.tgUser.id);

      // FAST CORE PULSE:
      // user check + pulse history dibaca paralel agar tap tidak terasa berat.
      const [user, status] = await Promise.all([
        getUser(telegramId),
        getPulseStatus(telegramId)
      ]);

      if (!user) {
        return res.status(404).json({
          error: "User tidak ditemukan."
        });
      }

      if (status.pulseActive) {
        return res.status(409).json({
          error: "Core Pulse MAX sedang aktif.",
          ...status
        });
      }

      const tapAt = Date.now();
      const nextLevel = Math.min(3, Number(status.pulseLevel || 0) + 1);

      // Insert langsung dan wajib sukses. Tidak memanggil publicState() karena
      // frontend hanya memerlukan status Pulse untuk setiap tap.
      const { error: insertError } = await supabase
        .from("transactions")
        .insert({
          telegram_id: telegramId,
          type: "core_pulse",
          amount: 0,
          status: "completed",
          tx_signature: null,
          note: `Core Pulse ${nextLevel}/3`,
          created_at: tapAt
        });

      if (insertError) {
        throw insertError;
      }

      const activated = nextLevel >= 3;
      const updatedStatus = {
        pulseLevel: nextLevel,
        pulseTapCount: nextLevel,
        pulseActive: activated,
        pulseMultiplier: activated ? PULSE_MAX_MULTIPLIER : 1,
        pulseExpiresAt: activated
          ? tapAt + PULSE_BOOST_DURATION_MS
          : 0,
        pulseRemainingMs: activated
          ? PULSE_BOOST_DURATION_MS
          : 0
      };

      res.json({
        ...updatedStatus,
        tapAccepted: true,
        activated,
        serverNow: tapAt
      });

    } catch (error) {
      console.error("Core Pulse error:", error?.message || error);
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
   AUTO WITHDRAW JASLIN V5.1
   Dedicated JASLIN hot wallet on TON. Native transaction gas is paid in GRAM.
   Min 2,000 JASLIN | Fee 300 | default global cap 20,000/day
========================================= */

function toJettonUnits(value) {
  const fixed = Number(value).toFixed(JASLIN_DECIMALS);
  const [whole, fraction = ""] = fixed.split(".");
  const padded = fraction.padEnd(JASLIN_DECIMALS, "0");
  return BigInt(whole) * (10n ** BigInt(JASLIN_DECIMALS)) +
    BigInt(padded || "0");
}

function hotWalletConfigReady() {
  return Boolean(JASLIN_HOT_WALLET_ADDRESS && JASLIN_HOT_WALLET_MNEMONIC);
}

async function openJaslinHotWallet() {
  if (!hotWalletConfigReady()) {
    throw new Error("Hot wallet Auto WD belum dikonfigurasi.");
  }

  const mnemonic = JASLIN_HOT_WALLET_MNEMONIC.split(/\s+/).filter(Boolean);
  if (mnemonic.length !== 12 && mnemonic.length !== 24) {
    throw new Error("Recovery phrase hot wallet harus 12 atau 24 kata.");
  }

  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const expected = Address.parse(JASLIN_HOT_WALLET_ADDRESS);
  const expectedRaw = expected.toRawString();

  const walletV4 = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey
  });
  const walletV5 = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
    walletId: { networkGlobalId: -239 }
  });

  let walletContract;
  if (walletV4.address.toRawString() === expectedRaw) {
    walletContract = walletV4;
  } else if (walletV5.address.toRawString() === expectedRaw) {
    walletContract = walletV5;
  } else {
    throw new Error("Recovery phrase tidak cocok dengan alamat hot wallet Auto WD.");
  }

  const nativeBalance = await tonClient.getBalance(expected);
  if (nativeBalance < toNano(String(HOT_WALLET_MIN_GRAM))) {
    throw new Error(
      `Saldo GRAM hot wallet terlalu kecil untuk gas. Sisakan minimal ${HOT_WALLET_MIN_GRAM} GRAM.`
    );
  }

  return {
    expected,
    keyPair,
    openedWallet: tonClient.open(walletContract)
  };
}

async function prepareJaslinHotWalletTransfer(destinationAddress, amount, queryIdText, hot) {
  // Resolve all RPC-dependent addresses BEFORE the withdrawal is marked as
  // broadcast-ambiguous. If this preflight fails, the reservation can safely
  // be refunded because no external message has been sent yet.
  const jettonMaster = tonClient.open(
    JettonMaster.create(Address.parse(JASLIN_JETTON_MASTER))
  );
  const hotJettonWallet = await jettonMaster.getWalletAddress(hot.expected);
  const destination = Address.parse(destinationAddress);
  const queryId = BigInt(queryIdText);

  const transferBody = beginCell()
    .storeUint(0xf8a7ea5, 32)
    .storeUint(queryId, 64)
    .storeCoins(toJettonUnits(amount))
    .storeAddress(destination)
    .storeAddress(hot.expected)
    .storeBit(0)
    .storeCoins(toNano("0.02"))
    .storeBit(0)
    .endCell();

  const seqnoBefore = await hot.openedWallet.getSeqno();
  const sender = hot.openedWallet.sender(hot.keyPair.secretKey);

  return {
    queryId: queryId.toString(),
    destination: destination.toString({ bounceable: false, urlSafe: true }),
    seqnoBefore,
    send: async () => {
      await sender.send({
        to: hotJettonWallet,
        value: toNano("0.08"),
        body: transferBody
      });
    }
  };
}

async function waitForHotWalletSeqno(openedWallet, seqnoBefore) {
  // Best-effort confirmation that the wallet accepted the outgoing message.
  // Never use a polling timeout as a reason to refund after send() was called.
  try {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1250));
      const seqnoNow = await openedWallet.getSeqno();
      if (seqnoNow > seqnoBefore) return true;
    }
  } catch (error) {
    console.warn("Hot wallet confirmation polling warning:", error?.message || error);
  }
  return false;
}

async function acquireHotWalletLease(lockToken) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { data, error } = await supabase.rpc("jaslin_acquire_hot_wallet_lock", {
      p_lock_token: lockToken,
      p_now: Date.now(),
      p_lease_ms: 30000
    });
    if (error) throw error;
    if (data === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function releaseHotWalletLease(lockToken) {
  try {
    await supabase.rpc("jaslin_release_hot_wallet_lock", {
      p_lock_token: lockToken,
      p_now: Date.now()
    });
  } catch (error) {
    console.warn("Hot wallet lock release warning:", error?.message || error);
  }
}

async function refundReservedAutoWithdrawal(requestId, reason) {
  const { data, error } = await supabase.rpc("jaslin_refund_auto_withdrawal", {
    p_request_id: requestId,
    p_reason: String(reason || "Auto withdrawal failed before broadcast"),
    p_now: Date.now()
  });
  if (error) throw error;
  return data || {};
}

app.post(
  "/api/withdraw",
  auth,
  maintenanceGuard,
  limitWithdraw,
  async (req, res) => {
    let requestId = "";
    let reserved = false;
    let broadcastStarted = false;
    let lockToken = "";

    const patchWithdrawal = async (patch, onlyStatus = null) => {
      let q = supabase
        .from("withdrawals")
        .update({ ...patch, updated_at: Date.now() })
        .eq("request_id", requestId)
        .eq("telegram_id", String(req.tgUser.id));
      if (onlyStatus) q = q.eq("status", onlyStatus);
      const { data, error } = await q.select("request_id,status,query_id").maybeSingle();
      if (error) throw error;
      return data;
    };

    try {
      if (!WITHDRAWALS_ENABLED) {
        return res.status(503).json({ error: "Auto withdrawal sedang dinonaktifkan." });
      }
      if (!hotWalletConfigReady()) {
        return res.status(503).json({ error: "Hot wallet Auto WD belum siap." });
      }

      const user = await getUser(req.tgUser.id);
      if (!user) return res.status(404).json({ error: "User tidak ditemukan." });

      requestId = String(req.body?.requestId || "").trim();
      if (!/^[a-zA-Z0-9_-]{12,100}$/.test(requestId)) {
        return res.status(400).json({ error: "Withdrawal request ID tidak valid." });
      }

      const amount = Math.floor(Number(req.body?.amount || 0));
      if (!Number.isFinite(amount) || amount < MIN_WITHDRAW_JASLIN) {
        return res.status(400).json({
          error: `Minimum withdrawal ${MIN_WITHDRAW_JASLIN.toLocaleString()} JASLIN.`
        });
      }

      if (!user.wallet) {
        return res.status(400).json({ error: "Connect wallet terlebih dahulu." });
      }
      Address.parse(user.wallet);

      const { data: reserveData, error: reserveError } = await supabase.rpc(
        "jaslin_reserve_auto_withdrawal",
        {
          p_request_id: requestId,
          p_telegram_id: String(user.telegram_id),
          p_wallet: user.wallet,
          p_amount: amount,
          p_fee: WITHDRAW_FEE_JASLIN,
          p_now: Date.now(),
          p_daily_cap: AUTO_WITHDRAW_DAILY_CAP_JASLIN,
          p_cooldown_ms: Math.round(WITHDRAW_COOLDOWN_HOURS * 3600000)
        }
      );

      if (reserveError) {
        const msg = String(reserveError.message || "");
        if (msg.includes("WITHDRAWAL_ACTIVE_EXISTS")) {
          return res.status(409).json({ error: "Masih ada withdrawal yang sedang diproses." });
        }
        if (msg.includes("WITHDRAWAL_COOLDOWN")) {
          return res.status(429).json({ error: `Withdrawal hanya dapat dilakukan setiap ${WITHDRAW_COOLDOWN_HOURS} jam.` });
        }
        if (msg.includes("DAILY_WITHDRAW_CAP_REACHED")) {
          return res.status(429).json({ error: "Kuota Auto WD JASLIN hari ini sudah tercapai." });
        }
        if (msg.includes("INSUFFICIENT_BALANCE")) {
          return res.status(400).json({ error: "Saldo game JASLIN tidak cukup." });
        }
        if (msg.includes("INVALID_WITHDRAW_AMOUNT")) {
          return res.status(400).json({ error: `Minimum withdrawal ${MIN_WITHDRAW_JASLIN.toLocaleString()} JASLIN.` });
        }
        if (msg.includes("jaslin_reserve_auto_withdrawal")) {
          return res.status(503).json({ error: "SQL Auto Withdrawal V5.3 belum sinkron di Supabase." });
        }
        throw reserveError;
      }

      const reservation = reserveData || {};
      if (reservation.idempotent) {
        const status = String(reservation.status || "");
        return res.status(["sent","confirmed"].includes(status) ? 200 : 202).json({
          ...await publicState(user),
          idempotent: true,
          withdrawalStatus: status,
          requestId,
          received: Number(reservation.receiveAmount || 0),
          queryId: reservation.queryId || null
        });
      }

      reserved = true;
      const receiveAmount = Number(reservation.receiveAmount || (amount - WITHDRAW_FEE_JASLIN));

      await saveTransaction(
        user.telegram_id,
        "withdraw_pending",
        -amount,
        `Auto WD ${requestId}: request ${amount} JASLIN; fee ${WITHDRAW_FEE_JASLIN}`,
        null,
        "pending"
      );

      // Validate hot-wallet address, mnemonic and native GRAM gas BEFORE a query id
      // is attached to the withdrawal. Preflight failures are safe to refund.
      const hot = await openJaslinHotWallet();

      lockToken = `${requestId}_${crypto.randomBytes(8).toString("hex")}`;
      const locked = await acquireHotWalletLease(lockToken);
      if (!locked) {
        throw new Error("Hot wallet sedang memproses withdrawal lain. Coba lagi sebentar.");
      }

      const random16 = BigInt(crypto.randomBytes(2).readUInt16BE(0));
      const queryId = ((BigInt(Date.now()) << 16n) | random16).toString();

      // Resolve Jetton wallet + destination + current seqno while the request is
      // still safely refundable.
      const prepared = await prepareJaslinHotWalletTransfer(
        user.wallet,
        receiveAmount,
        queryId,
        hot
      );

      const claimed = await patchWithdrawal(
        { status: "processing", query_id: queryId, error_message: null },
        "reserved"
      );
      if (!claimed) {
        return res.status(202).json({
          error: "Withdrawal sudah sedang diproses.",
          requestId,
          withdrawalStatus: "processing"
        });
      }

      // From the exact send() boundary onward, a network error can be ambiguous.
      // Never auto-refund after this point; use REVIEW to avoid double payout.
      broadcastStarted = true;
      await prepared.send();

      const seqnoAdvanced = await waitForHotWalletSeqno(
        hot.openedWallet,
        prepared.seqnoBefore
      );

      const chain = {
        submitted: true,
        queryId: prepared.queryId,
        destination: prepared.destination,
        seqnoAdvanced
      };

      const finalStatus = chain.seqnoAdvanced ? "sent" : "review";

      await patchWithdrawal({
        status: finalStatus,
        query_id: chain.queryId,
        error_message: chain.seqnoAdvanced ? null : "Broadcast submitted; wallet seqno not confirmed yet"
      });

      if (chain.seqnoAdvanced) {
        await saveTransaction(
          user.telegram_id,
          "withdraw_sent",
          receiveAmount,
          `Auto WD ${requestId} submitted; fee ${WITHDRAW_FEE_JASLIN}; query ${chain.queryId}`,
          chain.queryId,
          "sent"
        );
      }

      const updated = await getUser(user.telegram_id);
      return res.status(chain.seqnoAdvanced ? 200 : 202).json({
        ...await publicState(updated),
        withdrawn: amount,
        fee: WITHDRAW_FEE_JASLIN,
        received: receiveAmount,
        destination: chain.destination,
        queryId: chain.queryId,
        withdrawalStatus: finalStatus,
        requestId
      });

    } catch (error) {
      console.error("Auto withdrawal error:", safeErrorDetails(error));

      if (reserved && !broadcastStarted) {
        try {
          await refundReservedAutoWithdrawal(requestId, error?.message || "Preflight failed");
          await saveTransaction(
            req.tgUser.id,
            "withdraw_refund",
            Math.floor(Number(req.body?.amount || 0)),
            `Auto WD ${requestId} gagal sebelum broadcast; saldo dikembalikan`,
            null,
            "refunded"
          );
        } catch (refundError) {
          console.error("Auto WD refund error:", safeErrorDetails(refundError));
        }
      } else if (reserved && broadcastStarted) {
        try {
          await patchWithdrawal({
            status: "review",
            error_message: `Broadcast status uncertain: ${error?.message || error}`
          });
        } catch (patchError) {
          console.error("Auto WD review-state error:", safeErrorDetails(patchError));
        }
      }

      return res.status(broadcastStarted ? 202 : 500).json({
        error: broadcastStarted
          ? "Transaksi sudah dicoba ke jaringan. Status sedang diperiksa; saldo tidak direfund otomatis untuk mencegah pembayaran ganda."
          : (error?.message || "Auto withdrawal gagal."),
        requestId,
        withdrawalStatus: broadcastStarted ? "review" : "refunded"
      });
    } finally {
      if (lockToken) await releaseHotWalletLease(lockToken);
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
        !JASLIN_HOT_WALLET_MNEMONIC
      ) {

        return res
          .status(500)
          .json({
            ok:
              false,
            error:
              "JASLIN_HOT_WALLET_MNEMONIC belum tersedia."
          });

      }

      if (
        !JASLIN_HOT_WALLET_ADDRESS
      ) {

        return res
          .status(500)
          .json({
            ok:
              false,
            error:
              "JASLIN_HOT_WALLET_ADDRESS belum tersedia."
          });

      }


      /* VALIDATE EXPECTED ADDRESS */

      const expected =
        Address.parse(
          JASLIN_HOT_WALLET_ADDRESS
        );

      const mnemonic =
        JASLIN_HOT_WALLET_MNEMONIC
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
            ? "Hot wallet cocok dengan recovery phrase."
            : "Alamat hot wallet belum cocok dengan V4/V5."

      });

    } catch (
      error
    ) {

      console.error(
        "Hot wallet check error:",
        error
      );

      res
        .status(500)
        .json({
          ok:
            false,
          error:
            "Hot wallet check gagal.",
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
        true,

      fastCorePulse:
        true,

      performancePack:
        true,

      poolCacheMs:
        POOL_CACHE_TTL_MS,

      walletBalanceCacheMs:
        WALLET_BALANCE_CACHE_TTL_MS

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
    const treasuryAddress = Address.parse(JASLIN_HOT_WALLET_ADDRESS);
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



/* =========================================
   TELEGRAM BOT COMMAND WEBHOOK
   /start and /help only. Does not touch game APIs.
========================================= */

const TELEGRAM_API_BASE = BOT_TOKEN
  ? `https://api.telegram.org/bot${BOT_TOKEN}`
  : "";

async function telegramApi(method, payload) {
  if (!TELEGRAM_API_BASE) {
    throw new Error("BOT_TOKEN belum diset.");
  }

  const response = await fetch(`${TELEGRAM_API_BASE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data?.ok === false) {
    throw new Error(
      data?.description || `Telegram API ${method} gagal.`
    );
  }

  return data;
}

function jaslinOpenKeyboard() {
  return {
    inline_keyboard: [[
      {
        text: "🚀 OPEN JASLIN",
        web_app: {
          url: "https://jaslin-game.vercel.app/"
        }
      }
    ]]
  };
}

function normalizeTelegramCommand(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)[0]
    .toLowerCase()
    .split("@")[0];
}

app.post("/api/telegram/webhook", async (req, res) => {
  // Acknowledge Telegram quickly; command reply continues in this invocation.
  res.status(200).json({ ok: true });

  try {
    const message = req.body?.message;
    const chatId = message?.chat?.id;
    const command = normalizeTelegramCommand(message?.text);

    if (!chatId || !command) return;

    if (command === "/start") {
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text:
          "⚡ Welcome to JASLIN!\n\n" +
          "Mine JASLIN, increase your Core Power, invite friends, and build your position in the JASLIN ecosystem.\n\n" +
          "⛏ Mine JASLIN\n" +
          "⚡ Upgrade Core\n" +
          "👥 Invite Friends\n" +
          "💎 Earn Rewards\n" +
          "🌐 Built on TON\n\n" +
          "Tap below to enter JASLIN.",
        reply_markup: jaslinOpenKeyboard()
      });
      return;
    }

    if (command === "/help") {
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text:
          "❓ JASLIN Help\n\n" +
          "⛏ Mining — Mine JASLIN during your active mining cycle.\n" +
          "⚡ Core — Increase Core Power by meeting the required JASLIN holding.\n" +
          "👥 Friends — Invite friends and earn referral rewards.\n" +
          "💎 Wallet — Connect your TON wallet for Holding Power and supported game functions.\n\n" +
          "🔐 JASLIN will never ask for your seed phrase or private key.\n\n" +
          "Tap below to open the game.",
        reply_markup: jaslinOpenKeyboard()
      });
    }
  } catch (error) {
    console.error(
      "Telegram webhook error:",
      safeErrorDetails(error)
    );
  }
});


/* =========================================
   TELEGRAM WEBHOOK SETUP
   Protected by TREASURY_ADMIN_KEY.
========================================= */
app.get("/api/setup-telegram-webhook", treasuryAdminAuth, async (req, res) => {
  try {
    if (!BOT_TOKEN) {
      return res.status(500).json({ ok: false, error: "BOT_TOKEN belum tersedia." });
    }

    const webhookUrl = "https://jaslin-game.vercel.app/api/telegram/webhook";

    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          allowed_updates: ["message"]
        })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data?.ok === false) {
      return res.status(502).json({
        ok: false,
        error: data?.description || "Telegram setWebhook gagal."
      });
    }

    return res.json({
      ok: true,
      telegram: {
        ok: true,
        description: data?.description || "Webhook was set"
      },
      webhookUrl
    });
  } catch (error) {
    console.error("Telegram setWebhook error:", safeErrorDetails(error));
    return res.status(500).json({
      ok: false,
      error: "Gagal mengaktifkan Telegram webhook."
    });
  }
});

// Explicit Mini App entry route.
// Vercel may execute server.js from a bundled serverless directory, so do not
// rely on express.static() alone to resolve GET /.
app.get("/", (req, res) => {
  const candidates = [
    path.join(process.cwd(), "public", "index.html"),
    path.join(__dirname, "public", "index.html")
  ];

  const filePath = candidates.find((candidate) => {
    try {
      return requireFileExists(candidate);
    } catch {
      return false;
    }
  });

  if (!filePath) {
    return res.status(500).send("JASLIN Mini App index.html tidak ditemukan di deployment.");
  }

  return res.sendFile(filePath);
});

function requireFileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

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
