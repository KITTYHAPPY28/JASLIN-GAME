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
    500
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

/* =========================================
   JASLIN TOKEN
========================================= */

const JASLIN_JETTON_MASTER =
  "EQAmDnasFQqqiEFBjHy4tI0iIw1r-OtFeOSa0J9CJ4fNhjjx";

const tonClient = new TonClient({
  endpoint: TON_RPC_URL,
  apiKey: TONCENTER_API_KEY
});

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

// Core Pulse: up to 3 active taps, each valid for 10 minutes.
const PULSE_DURATION_MS = 10 * 60 * 1000;
const PULSE_MULTIPLIERS = [1, 1.03, 1.06, 1.10];

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

  if (
    now -
    authDate >
    86400
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
  const from = Math.max(0, startAt - PULSE_DURATION_MS);

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

async function getPulseStatus(telegramId) {
  const now = Date.now();
  const events = await getPulseEvents(
    telegramId,
    now - PULSE_DURATION_MS,
    now
  );

  const active = events
    .filter((time) => time + PULSE_DURATION_MS > now)
    .slice(-3);

  const pulseLevel = Math.min(3, active.length);
  const pulseMultiplier = PULSE_MULTIPLIERS[pulseLevel];

  return {
    pulseLevel,
    pulseMultiplier,
    pulseExpiresAt: active.length
      ? Math.min(...active.map((time) => time + PULSE_DURATION_MS))
      : 0
  };
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

  for (const pulseAt of pulseEvents) {
    const pulseStart = Math.max(startAt, pulseAt);
    const pulseEnd = Math.min(
      endAt,
      pulseAt + PULSE_DURATION_MS
    );

    if (pulseStart < pulseEnd) {
      boundaries.add(pulseStart);
      boundaries.add(pulseEnd);
    }
  }

  const points = [...boundaries].sort((a, b) => a - b);
  let reward = 0;

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const midpoint = a + (b - a) / 2;

    const activePulseCount = Math.min(
      3,
      pulseEvents.filter(
        (pulseAt) =>
          pulseAt <= midpoint &&
          pulseAt + PULSE_DURATION_MS > midpoint
      ).length
    );

    reward +=
      (b - a) *
      basePerMs *
      PULSE_MULTIPLIERS[activePulseCount];
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

    const {
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
            ""

        })
        .eq(
          "telegram_id",
          telegramId
        );

    if (error) {
      throw error;
    }

    return await getUser(
      telegramId
    );
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

        created_at:
          createdAt

      });

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

      const newBalance =
        Number(
          referrer.balance
        ) +
        REFERRAL_REWARD;

      const {
        error:
          referralError
      } =
        await supabase
          .from("users")
          .update({
            balance:
              newBalance
          })
          .eq(
            "telegram_id",
            referredBy
          );

      if (
        referralError
      ) {
        throw referralError;
      }

      await saveTransaction(
        referredBy,
        "referral",
        REFERRAL_REWARD,
        `Referral dari ${telegramId}`
      );

    }

  }

  return await getUser(
    telegramId
  );
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

      const user =
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

      const claimed =
        Number(
          (await calculateMining(user)).toFixed(8)
        );

      if (
        claimed <= 0
      ) {

        return res
          .status(400)
          .json({
            error:
              "Belum ada mining."
          });

      }

      const newBalance =
        Number(
          user.balance
        ) +
        claimed;

      const now =
        Date.now();

      const {
        error
      } =
        await supabase
          .from("users")
          .update({

            balance:
              newBalance,

            mining_started_at:
              now

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

      await saveTransaction(
        req.tgUser.id,
        "mining",
        claimed,
        "Mining claim"
      );
      if (user.referred_by) {
  const referrer = await getUser(user.referred_by);

  if (referrer) {
    const referralCommission = claimed * 0.10;

    const referrerNewBalance =
      Number(referrer.balance) + referralCommission;

    const {
      error: commissionError
    } = await supabase
      .from("users")
      .update({
        balance: referrerNewBalance
      })
      .eq(
        "telegram_id",
        String(user.referred_by)
      );

    if (commissionError) {
      throw commissionError;
    }

    await saveTransaction(
      user.referred_by,
      "referral_commission",
      referralCommission,
      `10% mining commission dari ${req.tgUser.id}`
    );
  }
      }

      const updated =
        await getUser(
          req.tgUser.id
        );

      res.json({

        ...await publicState(
          updated
        ),

        claimed:
          Number(
            claimed.toFixed(
              4
            )
          )

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
            "Claim mining gagal."
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

      const {
        error
      } =
        await supabase
          .from("users")
          .update({

            balance:
              newBalance,

            last_spin_at:
              now

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
    console.error("JASLIN pool error:", error);

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
            error
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
        error
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
            error
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

      const { error } =
        await supabase
          .from("users")
          .update({
            level: targetLevel
          })
          .eq(
            "telegram_id",
            String(req.tgUser.id)
          );

      if (error) {
        throw error;
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
        error
      );

      res.status(500).json({
        error: "Upgrade Core gagal."
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
  async (req, res) => {
    try {
      const user = await getUser(req.tgUser.id);

      if (!user) {
        return res.status(404).json({
          error: "User tidak ditemukan."
        });
      }

      const status = await getPulseStatus(user.telegram_id);

      if (status.pulseLevel >= 3) {
        return res.status(400).json({
          error: "Core Pulse sudah maksimum 3/3.",
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
        activated: true
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

  // Wait briefly for wallet seqno to advance.
  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const seqnoNow = await openedWallet.getSeqno();
    if (seqnoNow > seqnoBefore) break;
  }

  return {
    queryId: queryId.toString(),
    destination: destination.toString({ bounceable: false, urlSafe: true })
  };
}

app.post(
  "/api/withdraw",
  auth,
  async (req, res) => {
    let reserved = false;
    let reservedAmount = 0;

    try {
      if (!WITHDRAWALS_ENABLED) {
        return res.status(503).json({
          error: "Withdrawal sedang dinonaktifkan untuk pengujian treasury."
        });
      }

      const user = await getUser(req.tgUser.id);

      if (!user) {
        return res.status(404).json({
          error: "User tidak ditemukan."
        });
      }

      const amount = Math.floor(Number(req.body?.amount || 0));

      if (!Number.isFinite(amount) || amount < MIN_WITHDRAW_JASLIN) {
        return res.status(400).json({
          error: `Minimum withdrawal ${MIN_WITHDRAW_JASLIN.toLocaleString()} JASLIN.`
        });
      }

      if (!user.wallet) {
        return res.status(400).json({
          error: "Connect TON Wallet terlebih dahulu."
        });
      }

      Address.parse(user.wallet);

      const currentBalance = Number(user.balance || 0);

      if (amount > currentBalance) {
        return res.status(400).json({
          error: "Saldo game JASLIN tidak cukup."
        });
      }

      const receiveAmount = amount - WITHDRAW_FEE_JASLIN;

      if (receiveAmount <= 0) {
        return res.status(400).json({
          error: "Jumlah withdrawal terlalu kecil setelah fee."
        });
      }

      const newBalance = currentBalance - amount;

      const { data: reservedUser, error: reserveError } =
        await supabase
          .from("users")
          .update({ balance: newBalance })
          .eq("telegram_id", String(user.telegram_id))
          .eq("balance", user.balance)
          .select("telegram_id")
          .maybeSingle();

      if (reserveError) throw reserveError;

      if (!reservedUser) {
        return res.status(409).json({
          error: "Saldo berubah. Coba withdrawal kembali."
        });
      }

      reserved = true;
      reservedAmount = amount;

      await saveTransaction(
        user.telegram_id,
        "withdraw_pending",
        -amount,
        `Withdrawal request ${amount} JASLIN; fee ${WITHDRAW_FEE_JASLIN}`,
        null,
        "pending"
      );

      const chain = await sendJaslinFromTreasury(
        user.wallet,
        receiveAmount
      );

      await saveTransaction(
        user.telegram_id,
        "withdraw_completed",
        receiveAmount,
        `Withdrawal completed; fee ${WITHDRAW_FEE_JASLIN}; query ${chain.queryId}`,
        chain.queryId,
        "completed"
      );

      const updated = await getUser(user.telegram_id);

      res.json({
        ...await publicState(updated),
        withdrawn: amount,
        fee: WITHDRAW_FEE_JASLIN,
        received: receiveAmount,
        destination: chain.destination,
        queryId: chain.queryId
      });

    } catch (error) {
      console.error("Withdrawal error:", error);

      if (reserved) {
        try {
          const latest = await getUser(req.tgUser.id);
          const refundBalance =
            Number(latest?.balance || 0) + reservedAmount;

          await supabase
            .from("users")
            .update({ balance: refundBalance })
            .eq("telegram_id", String(req.tgUser.id));

          await saveTransaction(
            req.tgUser.id,
            "withdraw_refund",
            reservedAmount,
            "Withdrawal gagal; saldo dikembalikan",
            null,
            "refunded"
          );
        } catch (refundError) {
          console.error("Withdrawal refund error:", refundError);
        }
      }

      res.status(500).json({
        error: error?.message || "Withdrawal gagal."
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
        JASLIN_DECIMALS

    });

  }
);


/* =========================================
   START
========================================= */
app.get("/api/treasury-balance", async (req, res) => {
  try {
    const treasuryAddress = Address.parse(TON_TREASURY_ADDRESS);
    const jettonMasterAddress = Address.parse(JASLIN_JETTON_MASTER);

    const jettonMaster = tonClient.open(
      JettonMaster.create(jettonMasterAddress)
    );

    const jettonWalletAddress =
      await jettonMaster.getWalletAddress(treasuryAddress);

    const tonBalance = await tonClient.getBalance(treasuryAddress);

    res.json({
      ok: true,
      treasuryAddress: treasuryAddress.toString(),
      treasuryJettonWallet: jettonWalletAddress.toString(),
      tonBalanceNano: tonBalance.toString()
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

    console.log(
      `JASLIN server running on port
${PORT}`
    );
  }
);
