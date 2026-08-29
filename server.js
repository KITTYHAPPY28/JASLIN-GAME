import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { createClient } from "@supabase/supabase-js";

import { Address } from "@ton/core";
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
    0.045
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

const MIN_WITHDRAW_JASLIN =
  2000;

const MAX_LEVEL = 5000;
const LEVEL_PRICE_USD = 1;
const UPGRADE_COST_JASLIN = 200;

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

function calculateMining(user) {
  const started = Number(user.mining_started_at);

  const elapsed = Date.now() - started;

  // Maksimal mining 8 jam
  const MAX_MINING_TIME = 8 * 60 * 60 * 1000;

  const miningTime = Math.min(
    Math.max(0, elapsed),
    MAX_MINING_TIME
  );

  const minutes = miningTime / 60000;

  const MAX_LEVEL = 5000;

  const level = Math.min(
  MAX_LEVEL,
  Math.max(1, Number(user.level || 1))
);

// Level 1 = 100%
// Level 5000 = 200%
   const levelSpeed =
  1 + ((level - 1) / (MAX_LEVEL - 1));

  return minutes * MINING_PER_MINUTE * levelSpeed;
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

function publicState(
  user
) {

  const mining =
    calculateMining(
      user
    );

  const lastSpin =
    Number(
      user.last_spin_at
    );

  const spinAvailable =
    !lastSpin ||
    (
      Date.now() -
      lastSpin
    ) >=
    86400000;


  return {

    user: {

      id:
        user.telegram_id,

      username:
        user.username,

      firstName:
        user.first_name,

      wallet:
        user.wallet ||
        ""

    },

    balance:
      Number(
        Number(
          user.balance
        ).toFixed(4)
      ),

    mining:
      Number(
        mining.toFixed(4)
      ),

    miningPerMinute:
      MINING_PER_MINUTE,

    dailySpinAvailable:
      spinAvailable,

    referralLink:
      `https://t.me/${BOT_USERNAME}?startapp=ref_${user.telegram_id}`,

    network:
      "TON",

    jetton:
      JASLIN_JETTON_MASTER,

    minimumWithdraw:
  MIN_WITHDRAW_JASLIN,

level:
  Math.min(
    MAX_LEVEL,
    Math.max(1, Number(user.level || 1))
  ),

maxLevel:
  MAX_LEVEL,

levelPriceUsd:
  LEVEL_PRICE_USD

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
        publicState(
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
        publicState(
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
          calculateMining(
            user
          ).toFixed(8)
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

        ...publicState(
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

      const reward =
        DAILY_SPIN_REWARD;

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

        ...publicState(
          updated
        ),

        reward:
          reward

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
); /* =========================================
   JASLIN MARKET PRICE
========================================= */

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
// Pool ini: X = JASLIN, Y = GRAM.
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
/* =========================================
   LEVEL QUOTE
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

      const levelsToBuy =
        targetLevel - currentLevel;

      const priceUsd =
        levelsToBuy * LEVEL_PRICE_USD;

      const priceJaslin =
        levelsToBuy * UPGRADE_COST_JASLIN;

      res.json({
        ok: true,
        currentLevel,
        targetLevel,
        levelsToBuy,
        priceUsd,
        priceJaslin,
        pricePerLevelJaslin:
          UPGRADE_COST_JASLIN,
        pricePerLevelUsd:
          LEVEL_PRICE_USD
      });

    } catch (error) {

      console.error(
        "Level quote error:",
        error
      );

      res.status(500).json({
        error:
          "Gagal menghitung harga level."
      });

    }
  }
);


/* =========================================
   UPGRADE CORE
========================================= */

app.post(
  "/api/upgrade-core",
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

      if (currentLevel >= MAX_LEVEL) {
        return res.status(400).json({
          error:
            "Level maksimum sudah tercapai."
        });
      }

      const balance =
        Number(user.balance || 0);

      const cost =
        UPGRADE_COST_JASLIN;

      if (balance < cost) {
        return res.status(400).json({
          error:
            `Saldo tidak cukup. Butuh ${cost} JASLIN.`
        });
      }

      const newBalance =
        balance - cost;

      const newLevel =
        currentLevel + 1;

      const {
        error
      } =
        await supabase
          .from("users")
          .update({
            balance: newBalance,
            level: newLevel
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
        -cost,
        `Upgrade Core Level ${currentLevel} ke ${newLevel}`
      );

      const updated =
        await getUser(
          req.tgUser.id
        );

      res.json({
        ...publicState(updated),
        upgraded: true,
        previousLevel: currentLevel,
        newLevel,
        cost
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
